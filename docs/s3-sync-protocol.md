# OpenPass S3 / OSS 云端备份协议

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

`encryptedBackup` 解密后是兼容现有恢复逻辑的 `BackupData`。上传前会在内存中解除设备本地的备份密码层，再使用统一云端密码整体加密，避免不同设备必须共享本地主密码。备份对象明文只包含 OpenPass 格式版本和加密算法，不包含站点、账号、TOTP Secret、设备名、记录数量或备份时间。OSS 的追加索引还包含随机历史对象路径和加密校验信息；这些路径也可通过对象列表看到。

## 3. 对象布局

每次成功的本地备份对应一个不可变云端对象：

```text
<prefix>/v1/objects/<random-snapshot-id>.opb
```

对象 key 只使用随机 ID，避免泄露时间和设备信息。禁止用时间戳作为唯一排序依据。

另有一个固定 key：

```text
<prefix>/v1/latest.opb
```

标准 S3 的 `latest.opb` 保存同一份加密备份，供新设备无需 `ListBucket` 即可恢复。阿里云 OSS 改用 `<prefix>/v1/latest.idx` 追加索引：每行记录随机历史对象路径，以及由云端密码加密认证的路径和追加位置。恢复时验证最后一行，再下载对应备份；索引尚不存在时兼容读取旧 `latest.opb`。

## 4. 上传交互

### 标准 S3

1. `saveBackupSnapshot` 成功后生成随机 `snapshotId`。
2. 使用云端密码调用 `wrapBackupForCloud`；云端密码为空时拒绝上传。
3. `PUT objects/<snapshotId>.opb`，携带 `If-None-Match: *`。
4. 不可变对象成功后，再更新 `latest.opb`。
5. 首次创建 `latest.opb` 使用 `If-None-Match: *`；已有对象使用上次读取到的 ETag 和 `If-Match`。
6. 更新 latest 返回 412 时，保留已经上传成功的不可变对象，重新读取远端 latest，并让用户选择采用远端、本地或查看两份备份；不得无条件覆盖。

S3 官方规定 `If-Match` 会在 ETag 不匹配时拒绝写入，因此可用于避免多设备静默覆盖。其他 S3 兼容服务需支持条件上传。

### 阿里云 OSS

OSS PutObject 不支持上述条件 Header，因此使用原生 OSS V4 签名与 Fetch：

1. 上传随机历史对象，携带 `x-oss-forbid-overwrite: true`，不发送 `If-Match` 或 `If-None-Match`。
2. 按拉取索引时的字节长度执行 `AppendObject ?append&position=<length>`，提交最新历史对象路径。
3. 两台设备观察到同一长度时，仅一台能追加成功；另一台收到 409 `PositionNotEqualToLength`，保留历史对象并暂停同步。
4. 索引提交成功后才更新本地数据；校验失败、密码错误或已提交备份缺失均停止同步。

索引只追加，不参与历史清理，不允许在 OSS 控制台覆盖或删除。所有同步设备应升级到支持此索引的客户端；旧客户端写 `latest.opb` 不会更新新索引。当前索引上限为 8 MiB，达到上限时需更换前缀建立新备份；尚未实现索引压缩。未提交的历史对象保留以避免清理仍在进行的上传，因此冲突或失败残留对象可能超过配置的历史数量。

参考：[OSS 条件上传限制](https://help.aliyun.com/en/oss/user-guide/0017-00000245)、[AppendObject](https://help.aliyun.com/en/oss/developer-reference/appendobject)、[OSS V4 签名](https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4/)。

## 5. 为什么仍需要历史对象

“本地备份后立即上传云端”能显著降低单设备数据丢失风险，但不能单独解决以下情况：

- 两台设备离线修改后先后覆盖同一个 latest。
- 用户误删密钥后，删除状态也被自动备份并上传。
- 本地磁盘和浏览器数据同时损坏。
- 错误密码、扩展缺陷或损坏对象导致最新备份不可恢复。

先上传不可变对象，再更新 latest，可以保证 latest 冲突或错误备份不会删除先前版本。客户端默认最多保留 30 个、最长保留 90 天；用户可以在 1～200 个、1～3650 天范围内调整。任一条件超限即可清理，但至少保护最新历史对象和本次上传对象。也建议开启 Bucket Versioning 作为对象存储侧的第二层保护。

## 6. 凭据与权限

优先使用短期 STS 凭据。若允许用户直接填写 Access Key，Secret Access Key 必须由主密码加密后保存在 `chrome.storage.local`，只在解锁会话中使用，禁止进入日志、错误报告和备份对象。

权限必须限定为用户配置的对象前缀：

- `s3:GetObject`
- `s3:PutObject`
- `s3:ListBucket`，并限制到 `<prefix>/v1/`（连接测试与历史列表）
- `s3:DeleteObject`，并限制到 `<prefix>/v1/objects/*`

阿里云 RAM 对应 `oss:GetObject`、`oss:PutObject`（含追加）、`oss:ListObjects` 与 `oss:DeleteObject`。对象权限覆盖上述索引和历史路径；删除权限只需历史对象。

日常读取最新版本不依赖列表权限；连接测试需列表权限。历史版本界面和有限保留需要列表权限，自动清理需要删除权限。客户端只接受当前前缀下由随机 ID 组成的 `.opb` 历史 key，不允许界面传入任意对象 key。缺少列表或删除权限时同步结果仍然保留，但设置页会明确显示历史清理失败，避免重试不断生成额外版本。

## 7. 故障处理

- 网络错误：保留本地备份和待上传状态，指数退避重试。
- 401/403：标记凭据失效，不清除本地或云端状态。
- 404：latest 不存在时允许首次创建；不可变对象不存在视为恢复失败。
- S3 412 / OSS 409 PositionNotEqualToLength：并发更新，禁止覆盖，保留两份备份。
- 解密/GCM 认证失败：停止恢复，不返回部分数据，不上传本地对象覆盖远端。
- 云端上传完成后才记录 remote snapshot ID 和 ETag。
- 历史清理失败：不回滚已经成功的 latest 更新，不把清理失败当作上传失败重试。

## 8. 客户端实现

标准 S3 使用 AWS SDK for JavaScript v3。阿里云 OSS 的列表与历史读取使用 SDK 和 S3 兼容 Endpoint；写入、追加索引与删除使用原生 OSS V4 签名和 Fetch，支持无 DOM 的扩展 Service Worker。OSS 强制 Bucket 子域名地址，关闭 Path-style。

设置页保存以下非敏感字段：Endpoint、Bucket、Region、对象前缀、Path-style 开关、最多保留版本数和最长保留天数。Access Key ID、Secret Access Key、可选 Session Token 与云端加密密码组成一个整体，使用当前主密码加密后写入 `chrome.storage.local`。首次配置默认将当前主密码作为云端密码，也可选独立密码。修改主密码时同步重加密这组凭据，但保留已保存的云端密码；保存同一 Endpoint、Bucket、前缀时拒绝切换为不同密码，以保持历史版本可解密。

启用云端备份时会动态请求对应 Endpoint 的扩展访问权限；OSS 同时申请 S3 兼容和原生 Bucket 主机权限。远程 HTTP Endpoint 会被拒绝；仅 `localhost` 与 `127.0.0.1` 允许 HTTP，方便本地 MinIO 测试。

后台监听本地 `backupSnapshots` 变化并上传最新快照：

- OpenPass 已解锁：立即上传。
- OpenPass 已锁定：状态记为 pending，下次解锁自动重试。
- 网络或服务错误：按 5、15、60、180 分钟退避重试。
- S3 412 / OSS 409 并发冲突：保留不可变对象并停止自动覆盖，等待用户处理。

设置页提供连接检查、立即双向同步、恢复最新版本，以及历史版本列表和指定版本恢复。历史列表只展示 S3 返回的更新时间、密文大小和随机对象 ID；选择版本后才下载并在内存中解密。手动恢复支持合并导入和替换回滚，替换前保存本地加密快照，并为删除的记录生成墓碑；日常多设备同步则按记录 ID、更新时间和删除墓碑自动合并。

每次 latest 更新成功后执行有限保留：列出 `objects/` 下的历史密文，按 `LastModified` 从新到旧排序，然后删除超出版本数量或保留天数的对象。S3 分批删除，每批最多 1000 个 key；OSS 逐个删除已在索引提交的旧对象，保护当前指向的版本和未提交对象。`latest.opb` 与 `latest.idx` 均不参与清理。

## 9. 多设备合并

每份 `BackupData` 可以携带 `sync` 元数据：协议版本、随机设备 ID 和删除墓碑。业务数据仍使用现有 `secrets` 或 `encryptedData`，因此文件导入/恢复兼容旧备份。

后台在以下时机读取最新云端版本：扩展启动、用户解锁、云端配置变更后，以及每 5 分钟的定时任务。合并规则如下：

- HOTP：同一密钥合并最大计数；`sync.hotpCounters` 用密钥 SHA256 指纹记录已知最大计数，恢复后仍保留。多台离线设备同时生成 HOTP 无法保证唯一，建议使用单一设备。
- 相同记录 ID：选择 `updatedAt`、`createdAt`、`importedAt` 中时间最新的版本。
- 删除：比较墓碑的 `deletedAt` 与记录时间；墓碑更新时删除获胜。
- 同一 TOTP 被旧版本导入为不同 ID：按规范化站点和 Secret 去重，保留较新记录。
- 文件导入明确选择“全部保留”时，副本保留原始站点，使用独立 ID，并携带 `duplicateOf` 指向原记录。同步按副本 ID 保留这些记录；删除原记录或副本不会连带删除另一条。参与同步的客户端需更新到支持此字段的版本，旧客户端仍会按站点和 Secret 去重。
- 时间完全相同：使用规范化内容做确定性比较，确保所有设备最终选择同一版本。

后台先计算合并结果，使用拉取时的 S3 ETag 或 OSS 索引位置提交，成功后才写入本地；并发冲突或网络失败保持原本地记录。冲突暂停自动同步，设置页比较两端后可选择保留本地、保留云端或合并；确认时重新检查本地版本与配置，远端再次变化会因条件写拒绝提交。拉取和上传都要求处于已解锁会话；锁定期间状态为 pending，解锁后继续。
