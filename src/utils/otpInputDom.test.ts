// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { classifyOtpInput, isOtpInput } from './otpInput';
import { collectOtpInputSignals, detectOtpInputGroups } from './otpInputDom';

function page(html: string) {
  document.body.innerHTML = html;
  return Array.from(document.querySelectorAll<HTMLInputElement>('input'));
}
function codeInputs(count: number) {
  return '<span><input maxlength="1"></span>'.repeat(count);
}

describe('实际 DOM 的字段范围', () => {
  it('截图中的登录表单：账号、密码、图片验证码都不显示 OTP 按钮', () => {
    const inputs = page(`<form>
      <h1>Garvee 管理系统</h1>
      <div><input name="username"></div>
      <div><input type="password" name="password"></div>
      <div><span><input placeholder="验证码"></span><img src="data:image/png;base64,AA=="></div>
      <label><input type="checkbox">记住我</label>
      <button>登录</button>
    </form>`);
    expect(classifyOtpInput(collectOtpInputSignals(inputs[2]))).toMatchObject({
      role: 'code',
      source: 'image'
    });
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('图片验证码和验证器字段共处一张表单时分别判断', () => {
    const inputs = page(`<form>
      <div><label for="captcha">验证码</label><input id="captcha"><img src="challenge.png"></div>
      <div><label for="otp">身份验证器验证码</label><input id="otp" autocomplete="one-time-code"></div>
    </form>`);
    expect(detectOtpInputGroups(inputs).map((group) => group.anchor.id)).toEqual(['otp']);
  });

  it('短信备用方式不会覆盖当前字段明确关联的验证器说明', () => {
    const inputs = page(`<form>
      <div><input id="otp" placeholder="验证码" aria-describedby="auth-help"></div>
      <p id="auth-help">Enter the code from your authenticator app</p>
      <div><label>SMS code<input id="sms"></label></div>
    </form>`);
    expect(detectOtpInputGroups(inputs).map((group) => group.anchor.id)).toEqual(['otp']);
  });

  it('其他字段的标签不因当前 input 没有 id 而被关联', () => {
    const inputs = page(`<form>
      <label>身份验证器验证码<input id="totp"></label>
      <div><input placeholder="验证码"></div>
    </form>`);
    expect(collectOtpInputSignals(inputs[1]).labelText?.trim()).toBe('');
    expect(isOtpInput(collectOtpInputSignals(inputs[1]))).toBe(false);
  });

  it('MFA 字段要从明确关联的 app 说明获得来源', () => {
    const inputs = page(`<form>
      <input placeholder="输入动态MFA码" aria-labelledby="mfa-label" aria-describedby="mfa-help">
      <span id="mfa-label">MFA码</span><p id="mfa-help">从身份验证器获取动态码</p>
    </form>`);
    expect(isOtpInput(collectOtpInputSignals(inputs[0]))).toBe(true);
  });

  it('同层关联文案冲突时不自动选择其中一种来源', () => {
    const inputs = page(`<form>
      <label for="totp">图片验证码</label><input id="totp" aria-describedby="help">
      <p id="help">Use your authenticator app</p>
    </form>`);
    expect(classifyOtpInput(collectOtpInputSignals(inputs[0])).source).toBe('conflict');
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('其他字段文案不会改变来源，当前代码字段可独立使用输入约束', () => {
    const inputs = page(`<form>
      <div><p>身份验证器验证码</p><input id="auth" placeholder="code"></div>
      <div><input placeholder="验证码" maxlength="6" inputmode="numeric"></div>
    </form>`);
    expect(classifyOtpInput(collectOtpInputSignals(inputs[1])).source).toBe('unknown');
    expect(detectOtpInputGroups(inputs)).toHaveLength(2);
  });

  it('Keycloak 官方 OTP 字段结构不需要额外的验证器来源文案', () => {
    // https://github.com/keycloak/keycloak/blob/main/themes/src/main/resources/theme/base/login/login-otp.ftl
    const inputs = page(
      '<form id="kc-otp-login-form"><div><label for="otp">One-time code</label><div><input id="otp" name="otp" autocomplete="one-time-code" type="text"></div></div><input type="submit" value="Log In"></form>'
    );
    expect(classifyOtpInput(collectOtpInputSignals(inputs[0])).source).toBe('unknown');
    expect(detectOtpInputGroups(inputs).map((group) => group.anchor.id)).toEqual(['otp']);
  });

  it.each([
    '<form><input autocomplete="one-time-code"><button>验证</button></form>',
    '<form><label>验证码<input maxlength="6"></label><button>验证</button></form>',
    '<form><label>验证码<input inputmode="numeric"></label><button>验证</button></form>',
    '<form><label>验证码<input pattern="[0-9]{6}"></label><button>验证</button></form>',
    '<form><label>验证码<input></label><button>验证</button></form>',
    '<div><label>验证码<input></label><button type="submit">验证</button></div>',
    '<form><h2>Two-factor authentication</h2><input placeholder="Enter code"><button>Continue</button></form>',
    '<form><input placeholder="输入动态MFA码" autocomplete="off"><button>确认</button></form>'
  ])('泛提示或标准属性的正常 OTP 步骤可以显示填充按钮：%s', (html) => {
    const inputs = page(html);
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it.each([
    '<form><div><label>验证码<input autocomplete="one-time-code"></label><img src="challenge.png"></div><button>验证</button></form>',
    '<form><div><label>验证码<input maxlength="6"></label><img src="challenge.png"></div><button>验证</button></form>',
    '<form><div><label>验证码<input inputmode="numeric"></label><canvas></canvas></div><button>验证</button></form>',
    '<form><div><label>验证码<input></label><img src="challenge.png"></div><button>验证</button></form>',
    '<form><input autocomplete="one-time-code"><img src="challenge.png"><button>验证</button></form>'
  ])('相同兼容属性的图片验证码仍不显示填充按钮：%s', (html) => {
    const inputs = page(html);
    expect(classifyOtpInput(collectOtpInputSignals(inputs[0])).source).toBe('image');
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('普通登录表单里只有泛验证码文案且缺少输入约束时不猜测', () => {
    const inputs = page(
      '<form><input name="username"><input type="password"><input placeholder="验证码"><button>登录</button></form>'
    );
    expect(collectOtpInputSignals(inputs[2]).isCodeStep).toBe(false);
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('隐藏或声明为装饰的图片不会抹掉标准 OTP 兼容证据', () => {
    const inputs = page(
      '<form><div><label>验证码<input autocomplete="one-time-code"></label><img hidden src="inactive-captcha.png"><img aria-hidden="true" src="icon.png"></div><button>验证</button></form>'
    );
    expect(collectOtpInputSignals(inputs[0]).hasAdjacentImage).toBe(false);
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('表单 logo 不会当成代码字段的邻接图片', () => {
    const inputs = page(`<form>
      <img src="logo.png">
      <div><label>Authenticator code<input id="otp"></label></div>
    </form>`);
    expect(collectOtpInputSignals(inputs[0]).hasAdjacentImage).toBe(false);
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('泛标准 OTP 字段也不会因表单页头 logo 漏匹配', () => {
    const inputs = page(
      '<form><img src="logo.png"><input autocomplete="one-time-code"><button>Continue</button></form>'
    );
    expect(collectOtpInputSignals(inputs[0]).hasAdjacentImage).toBe(false);
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('只有一个代码字段的认证表单可从标题获得来源，logo 不影响判断', () => {
    const inputs = page(`<form>
      <img src="logo.png"><h2>Authenticator verification</h2>
      <input name="otp" autocomplete="one-time-code">
    </form>`);
    expect(collectOtpInputSignals(inputs[0]).hasAdjacentImage).toBe(false);
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('包含其他普通字段的表单标题不能证明泛验证码字段的来源', () => {
    const inputs = page(`<form><h2>Authenticator settings</h2>
      <div><input name="username"></div><div><input placeholder="验证码"></div>
    </form>`);
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });
});

describe('实际 DOM 的分位组', () => {
  it.each([6, 8])('带共享验证器说明的 %i 位输入只生成一个组', (length) => {
    const inputs = page(
      `<fieldset><legend>身份验证器验证码</legend><div>${codeInputs(length)}</div></fieldset>`
    );
    const groups = detectOtpInputGroups(inputs);
    expect(groups).toHaveLength(1);
    expect(groups[0].inputs).toEqual(inputs);
    expect(groups[0].isMulti).toBe(true);
  });

  it('两组验证码分别分类，不跨容器合并', () => {
    const inputs = page(`<form>
      <div><p>短信验证码</p>${codeInputs(6)}</div>
      <div><p>身份验证器验证码</p>${codeInputs(6)}</div>
    </form>`);
    const groups = detectOtpInputGroups(inputs);
    expect(groups).toHaveLength(1);
    expect(groups[0].inputs).toEqual(inputs.slice(6));
  });

  it('不会跳过普通字段再把两侧短框拼成一个组', () => {
    const inputs = page(`<fieldset><legend>身份验证器验证码</legend>
      ${codeInputs(3)}<input placeholder="username">${codeInputs(3)}
    </fieldset>`);
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('容器内不完整或有不可用成员时不创建可填充组', () => {
    let inputs = page(`<fieldset><legend>身份验证器验证码</legend>${codeInputs(5)}</fieldset>`);
    expect(detectOtpInputGroups(inputs)).toEqual([]);
    inputs = page(`<fieldset><legend>身份验证器验证码</legend>${codeInputs(6)}</fieldset>`);
    expect(detectOtpInputGroups(inputs.slice(1))).toEqual([]);
  });

  it('分位图片验证码不会凭六个短框成立', () => {
    const inputs = page(`<div><p>验证码</p>${codeInputs(6)}<canvas></canvas></div>`);
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('分组说明和组内图片给出冲突来源时不填充', () => {
    const inputs = page(`<fieldset><legend>身份验证器验证码</legend>
      <div>${codeInputs(6)}<canvas></canvas></div>
    </fieldset>`);
    expect(detectOtpInputGroups(inputs)).toEqual([]);
  });

  it('短框被分层包装时仍能找到完整组及共享说明', () => {
    const inputs = page(`<div><p>身份验证器验证码</p>
      <div>${codeInputs(3)}</div><div>${codeInputs(3)}</div>
    </div>`);
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('仅写验证码的完整分位验证步骤可以识别', () => {
    const inputs = page(
      '<form><div><p>验证码</p>' + codeInputs(6) + '</div><button>验证</button></form>'
    );
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('六个数字分位框通过组合结构识别，不需要字段逐个写来源', () => {
    const inputs = page(
      '<form><div>' +
        '<input maxlength="1" inputmode="numeric">'.repeat(6) +
        '</div><button>验证</button></form>'
    );
    expect(detectOtpInputGroups(inputs)).toHaveLength(1);
  });

  it('标准属性不能把图片分位组或不完整组变成 OTP', () => {
    const inputs = page(
      '<form><div>' +
        '<input maxlength="1" autocomplete="one-time-code">'.repeat(6) +
        '<canvas></canvas></div><button>验证</button></form>'
    );
    expect(detectOtpInputGroups(inputs)).toEqual([]);
    expect(detectOtpInputGroups(inputs.slice(0, 5))).toEqual([]);
  });
});
