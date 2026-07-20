# OpenPass S3 云端备份协议

## 1. 定位

云端能力复用现有备份与恢复链路，不引入另一套密钥数据库：

```text
secrets
  -> createBackupData
  -> saveBackupSnapshot（本地备份成功）
  -> wrapBackupForCloud（强制外层加密）
  -> S3 PutObject
```

恢复流程同样复用现有逻辑：

```text
S3 GetObject
  -> unwrapCloudBackup
  -> validateBackupData
  -> decryptBackupData（如果原备份自身也启用了加密）
  -> 现有导入/恢复逻辑
```

云端上传是本地备份成功后的异步副作用。本地备份失败时不得上传；云端上传失败不回滚已经成功的本地备份，而是记录待重试状态。

## 2. 加密边界

OSS/S3 仅作为不可信对象存储。不得直接上传 `BackupData`：未加密备份包含 TOTP Secret；现有加密备份仍会在外层暴露导出时间、记录数量和应用版本。

因此无论用户是否启用了本地备份加密，云端都必须再封装为：

```json
{
  "format": "openpass-cloud-backup",
  "version": 1,
  "cipher": "AES-256-GCM",
  "encryptedBackup": "<base64(salt || nonce || ciphertext || tag)>"
}
```

`encryptedBackup` 解密后就是原样的 `BackupData`。云端明文只包含 OpenPass 格式版本和加密算法，不包含站点、账号、TOTP Secret、设备名、记录数量或备份时间。

## 3. 对象布局

每次成功的本地备份对应一个不可变云端对象：

```text
<prefix>/v1/<random-vault-id>/objects/<random-snapshot-id>.opb
```

对象 key 只使用随机 ID，避免泄露时间和设备信息。禁止用时间戳作为唯一排序依据。

另有一个固定 key：

```text
<prefix>/v1/<random-vault-id>/latest.opb
```

`latest.opb` 保存同一份加密备份，供新设备无需 `ListBucket` 即可恢复。不可变对象用于历史恢复，`latest.opb` 用于快捷恢复。

## 4. 上传交互

1. `saveBackupSnapshot` 成功后生成随机 `snapshotId`。
2. 使用云端密码调用 `wrapBackupForCloud`；云端密码为空时拒绝上传。
3. `PUT objects/<snapshotId>.opb`，携带 `If-None-Match: *`。
4. 不可变对象成功后，再更新 `latest.opb`。
5. 首次创建 `latest.opb` 使用 `If-None-Match: *`；已有对象使用上次读取到的 ETag 和 `If-Match`。
6. 更新 latest 返回 412 时，保留已经上传成功的不可变对象，重新读取远端 latest，并让用户选择采用远端、本地或查看两份备份；不得无条件覆盖。

S3 官方规定 `If-Match` 会在 ETag 不匹配时拒绝写入，因此可用于避免多设备静默覆盖。兼容 OSS 必须支持 Signature V4、ETag、`If-Match` 和 `If-None-Match`。

## 5. 为什么仍需要历史对象

“本地备份后立即上传云端”能显著降低单设备数据丢失风险，但不能单独解决以下情况：

- 两台设备离线修改后先后覆盖同一个 latest。
- 用户误删密钥后，删除状态也被自动备份并上传。
- 本地磁盘和浏览器数据同时损坏。
- 错误密码、扩展缺陷或损坏对象导致最新备份不可恢复。

先上传不可变对象，再更新 latest，可以保证 latest 冲突或错误备份不会删除先前版本。建议同时开启 Bucket Versioning，并在云端保留最近 10 至 30 个对象；清理历史必须作为独立任务执行，不能发生在正常上传请求中。

## 6. 凭据与权限

优先使用短期 STS 凭据。若允许用户直接填写 Access Key，Secret Access Key 必须由主密码加密后保存在 `chrome.storage.local`，只在解锁会话中使用，禁止进入日志、错误报告和备份对象。

最小权限限定为随机 Vault 前缀：

- `s3:GetObject`
- `s3:PutObject`

读取 latest 不需要 `ListBucket`。历史列表可以在后续版本通过加密索引实现；首版不授予 `DeleteObject`，防止客户端缺陷批量删除云端备份。

## 7. 故障处理

- 网络错误：保留本地备份和待上传状态，指数退避重试。
- 401/403：标记凭据失效，不清除本地或云端状态。
- 404：latest 不存在时允许首次创建；不可变对象不存在视为恢复失败。
- 412：并发更新，禁止覆盖，保留两份备份。
- 解密/GCM 认证失败：停止恢复，不返回部分数据，不上传本地对象覆盖远端。
- 云端上传完成后才记录 remote snapshot ID 和 ETag。
