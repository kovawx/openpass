export interface OtpInputSignals {
  type: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  ariaLabel?: string;
  labelText?: string;
  descriptionText?: string;
  inputMode?: string;
  maxLength?: number;
  pattern?: string;
  /** 当前表单/控件只有一个代码字段（或一个完整的分位组）和提交操作。 */
  isCodeStep?: boolean;
  /** 只允许当前字段或明确关联的分组说明，不包含整张表单的文本。 */
  contextText?: string;
  hasAdjacentImage?: boolean;
}

export type CodeSource = 'authenticator' | 'image' | 'sms' | 'email';
export interface CodeSourceEvidence {
  source: CodeSource;
  scope: 'field' | 'local';
}
export interface OtpInputClassification {
  role: 'code' | 'credential' | 'other' | 'unknown';
  source: CodeSource | 'unknown' | 'conflict';
  evidence: CodeSourceEvidence[];
  hints: {
    standardOtp: boolean;
    otpIntent: boolean;
    codeConstraint: boolean;
    codeStep: boolean;
    contextCode: boolean;
  };
}

const INPUT_TYPES = ['text', 'tel', 'number', 'password'];
const TARGET_LENGTHS = [6, 8];
const SPLIT_MAX_LENGTH = 2;

// 这些词识别代码的来源，不负责决定是否显示填充按钮。
const SOURCE_TERMS: Record<CodeSource, string[]> = {
  authenticator: [
    'totp',
    'hotp',
    'authenticator',
    'authentication app',
    '验证器',
    '认证器',
    '身份验证应用',
    '动态口令'
  ],
  image: [
    'captcha',
    'image code',
    'picture code',
    'visual code',
    '图片验证码',
    '图形验证码',
    '图像验证码',
    '图中字符',
    '图中数字'
  ],
  sms: ['sms', 'text message', '短信'],
  email: [
    'email code',
    'email verification',
    'email otp',
    'e mail code',
    'e mail verification',
    'e mail otp',
    '邮箱验证码',
    '邮件验证码'
  ]
};
const CODE_TERMS = [
  'otp',
  'code',
  'pin',
  'token',
  'passcode',
  'one time password',
  'one time code',
  '验证码',
  '动态码',
  '安全码',
  '一次性密码'
];
const CREDENTIAL_TERMS = ['username', 'password', 'passwd', 'pwd', '用户名', '密码'];
const CODE_FIELD_NAMES = ['totp', 'hotp', 'totp input', 'hotp input', 'captcha'];
// 标准属性同时用于识别普通表单字段，避免将“Postal code”等当成 OTP。
const OTHER_AUTOFILL_FIELDS = new Set([
  'name',
  'given-name',
  'family-name',
  'email',
  'tel',
  'url',
  'postal-code',
  'street-address',
  'address-line1',
  'address-line2',
  'address-line3',
  'address-level1',
  'address-level2',
  'address-level3',
  'address-level4',
  'country',
  'country-name',
  'cc-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-type',
  'transaction-amount',
  'transaction-currency'
]);
const OTP_INTENT_TERMS = [
  'otp',
  'totp',
  'hotp',
  'mfa',
  '2fa',
  'two factor',
  'two step',
  'one time code',
  'one time password'
];

function normalize(value = ''): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  // 中文没有空格分词；英文按词匹配，避免 photopin 等子串误命中。
  if (/[\u3400-\u9fff]/.test(term)) return text.includes(term);
  let offset = text.indexOf(term);
  while (offset !== -1) {
    const before = text[offset - 1] || '';
    const after = text[offset + term.length] || '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    offset = text.indexOf(term, offset + 1);
  }
  return false;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => containsTerm(text, term));
}

function sourceEvidence(text: string, scope: CodeSourceEvidence['scope']): CodeSourceEvidence[] {
  return (Object.keys(SOURCE_TERMS) as CodeSource[])
    .filter((source) => containsAny(text, SOURCE_TERMS[source]))
    .map((source) => ({ source, scope }));
}

function resolveSource(evidence: CodeSourceEvidence[]): OtpInputClassification['source'] {
  // 当前字段的属性和显式关联说明比附近文案更具体，同层冲突不猜测。
  const fieldEvidence = evidence.filter((item) => item.scope === 'field');
  const sources = new Set(
    (fieldEvidence.length ? fieldEvidence : evidence).map((item) => item.source)
  );
  if (!sources.size) return 'unknown';
  return sources.size === 1 ? [...sources][0] : 'conflict';
}

/** 来源分类保留未知；兼容判断另采用标准属性、OTP 意图和代码输入约束。 */
export function classifyOtpInput(signals: OtpInputSignals): OtpInputClassification {
  const fieldText = [
    signals.name,
    signals.id,
    signals.placeholder,
    signals.ariaLabel,
    signals.labelText,
    signals.descriptionText
  ]
    .map((text) => normalize(text))
    .join(' ');
  const contextText = normalize(signals.contextText);
  const evidence = [...sourceEvidence(fieldText, 'field'), ...sourceEvidence(contextText, 'local')];
  const source = resolveSource(evidence);
  const autocomplete = (signals.autocomplete || '').toLowerCase().split(/\s+/);
  const credentialAutocomplete = autocomplete.some((token) =>
    ['current-password', 'new-password', 'username'].includes(token)
  );
  const usernameRole = containsAny(fieldText, ['username', '用户名']);
  const standardOtp = autocomplete.includes('one-time-code');
  const directOtpIntent = containsAny(fieldText, OTP_INTENT_TERMS);
  const contextOtpIntent = containsAny(contextText, OTP_INTENT_TERMS);
  const codeRole =
    standardOtp ||
    containsAny(fieldText, CODE_TERMS) ||
    (directOtpIntent && fieldText.includes('码')) ||
    [signals.name, signals.id].some((name) => CODE_FIELD_NAMES.includes(normalize(name)));
  const numericMode =
    ['numeric', 'tel'].includes((signals.inputMode || '').toLowerCase()) ||
    ['tel', 'number'].includes(signals.type);
  const numericCodeShape = numericMode && TARGET_LENGTHS.includes(signals.maxLength || 0);
  // 只读取常见数字约束的声明，不执行网页提供的正则。
  const numericPattern = /^\^?(?:\\d|\[0-9\])(?:[*+]|\{(?:6|8)\})\$?$/.test(signals.pattern || '');

  let role: OtpInputClassification['role'] = 'unknown';
  if (credentialAutocomplete || usernameRole) {
    role = 'credential';
  } else if (autocomplete.some((token) => OTHER_AUTOFILL_FIELDS.has(token))) {
    role = 'other';
  } else if (codeRole) {
    role = 'code';
  } else if (signals.type === 'password' || containsAny(fieldText, CREDENTIAL_TERMS)) {
    role = 'credential';
  } else if (numericCodeShape && (source !== 'unknown' || contextOtpIntent)) {
    role = 'code';
  }

  // 图片必须位于当前代码字段内，页面 logo 或其他字段的图片不会成为证据。
  if (signals.hasAdjacentImage && (role === 'code' || isShortInput(signals)))
    evidence.push({ source: 'image', scope: 'local' });
  return {
    role,
    source: resolveSource(evidence),
    evidence,
    hints: {
      standardOtp,
      otpIntent: directOtpIntent || contextOtpIntent,
      codeConstraint:
        numericMode || numericPattern || TARGET_LENGTHS.includes(signals.maxLength || 0),
      codeStep: signals.isCodeStep === true,
      contextCode: containsAny(contextText, CODE_TERMS)
    }
  };
}

export function isOtpInput(signals: OtpInputSignals): boolean {
  if (
    !INPUT_TYPES.includes(signals.type.toLowerCase()) ||
    ((signals.maxLength || 0) > 0 && (signals.maxLength || 0) < Math.min(...TARGET_LENGTHS))
  )
    return false;
  const classification = classifyOtpInput(signals);
  if (classification.role !== 'code') return false;
  if (classification.source === 'authenticator') return true;
  if (classification.source !== 'unknown') return false;
  const hints = classification.hints;
  return hints.standardOtp || hints.otpIntent || hints.codeConstraint || hints.codeStep;
}

function isShortInput(signals: OtpInputSignals): boolean {
  return (signals.maxLength || 0) >= 1 && (signals.maxLength || 0) <= SPLIT_MAX_LENGTH;
}

/** 短框只用于收集分组；最终识别必须通过相同的来源分类。 */
export function isPotentialSplitOtpInput(signals: OtpInputSignals): boolean {
  return (
    INPUT_TYPES.includes(signals.type.toLowerCase()) &&
    isShortInput(signals) &&
    ['code', 'unknown'].includes(classifyOtpInput(signals).role)
  );
}

export function isOtpSplitGroup(inputs: OtpInputSignals[]): boolean {
  if (!TARGET_LENGTHS.includes(inputs.length) || !inputs.every(isPotentialSplitOtpInput))
    return false;
  const classifications = inputs.map(classifyOtpInput);
  if (!classifications.every((item) => ['authenticator', 'unknown'].includes(item.source)))
    return false;
  // 完整分组加 OTP/代码语义或数字输入约束形成兼容证据，数量本身仍不足。
  return (
    classifications.some(
      (item) =>
        item.source === 'authenticator' ||
        item.hints.standardOtp ||
        item.hints.otpIntent ||
        item.hints.contextCode ||
        (item.role === 'code' && item.hints.codeStep)
    ) || classifications.every((item) => item.hints.codeConstraint)
  );
}
