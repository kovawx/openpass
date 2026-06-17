import { installGlobalRuntimeErrorListeners } from '@/utils/runtimeErrors';
import { isSiteMatched, parseUrl } from '@/utils/domainMatch';

interface ContentSecret {
  secret: string;
  site: string;
  name?: string;
  digits?: number;
}

/** 一个 OTP 组：单输入（整码）或多输入（逐位） */
interface OtpGroup {
  /** DOM 顺序的输入框；单输入组只有 1 个 */
  inputs: HTMLInputElement[];
  /** 组的第一个输入框，作为按钮的唯一 key */
  anchor: HTMLInputElement;
  isMulti: boolean;
}

interface GroupButtonEntry {
  group: OtpGroup;
  wrapper: HTMLDivElement;
  button: HTMLDivElement;
}

interface GenerateCodeResponse {
  code: string;
  remainingSeconds: number;
}

const CONFIG = {
  keywords: [
    'otp',
    'totp',
    '2fa',
    'mfa',
    'auth',
    'verification',
    'verify',
    'code',
    'pin',
    'token',
    'one-time',
    'onetime',
    '验证码',
    '动态码',
    '安全码',
    '一次性密码'
  ],
  excludeKeywords: ['password', 'passwd', 'pwd', '密码'],
  targetLengths: [6, 8],
  checkInterval: 1000,
  /** 分位输入框的 maxlength 上限（<= 视为逐位输入） */
  splitMaxLength: 2,
  /** 判定同组时向上查找共同祖先的层数 */
  groupAncestorDepth: 4
} as const;

installGlobalRuntimeErrorListeners('content', window, {
  ignoreExternalScriptErrors: true
});

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const groupButtons = new Map<HTMLInputElement, GroupButtonEntry>();
    let currentSecrets: ContentSecret[] = [];
    let currentUrl = window.location.href;
    let detectionIntervalId: number | null = null;
    let domObserver: MutationObserver | null = null;

    injectStyles();

    function injectStyles() {
      if (document.getElementById('openpass-content-styles')) {
        return;
      }
      const style = document.createElement('style');
      style.id = 'openpass-content-styles';
      style.textContent = CONTENT_STYLES;
      (document.head || document.documentElement).appendChild(style);
    }

    function closeSelector() {
      const selector = document.querySelector<HTMLDivElement>('.openpass-selector');
      if (!selector) {
        return;
      }

      clearSelectorInterval(selector);
      selector.remove();
    }

    function removeAllButtons() {
      closeSelector();
      Array.from(groupButtons.keys()).forEach((anchor) => {
        removeGroupButton(anchor);
      });
    }

    function getMatchingSecrets(): ContentSecret[] {
      const urlInfo = parseUrl(currentUrl);
      if (!urlInfo) {
        return [];
      }
      return currentSecrets.filter((secret) => isSiteMatched(urlInfo, secret.site));
    }

    async function fetchSecrets() {
      try {
        const result = await chrome.storage.local.get<{ secrets?: ContentSecret[] }>(['secrets']);
        currentSecrets = Array.isArray(result.secrets) ? result.secrets : [];
        updateAllButtons();
      } catch (error) {
        if ((error as Error).message?.includes('Extension context invalidated')) {
          console.warn('OpenPass: 扩展上下文已失效，请刷新页面');
          return;
        }

        throw error;
      }
    }

    function observeUrlChange() {
      const originalPushState = history.pushState;
      history.pushState = function (...args: Parameters<History['pushState']>) {
        originalPushState.apply(this, args);
        onUrlChange();
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function (...args: Parameters<History['replaceState']>) {
        originalReplaceState.apply(this, args);
        onUrlChange();
      };

      window.addEventListener('popstate', onUrlChange);
    }

    function onUrlChange() {
      if (currentUrl === window.location.href) {
        return;
      }

      currentUrl = window.location.href;
      removeAllButtons();
      detectInputs();
    }

    function startDetection() {
      detectInputs();

      if (detectionIntervalId === null) {
        detectionIntervalId = window.setInterval(detectInputs, CONFIG.checkInterval);
      }

      if (!domObserver && document.body) {
        domObserver = new MutationObserver((mutations) => {
          const shouldCheck = mutations.some((mutation) => mutation.addedNodes.length > 0);
          if (shouldCheck) {
            detectInputs();
          }
        });

        domObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    }

    function is2FAInput(input: HTMLInputElement): boolean {
      const typeValid = ['text', 'tel', 'number', 'password'].includes(input.type);
      if (!typeValid) return false;

      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      const autocomplete = (input.autocomplete || '').toLowerCase();
      const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
      const inputmode = (input.getAttribute('inputmode') || '').toLowerCase();
      const allText = `${name} ${id} ${placeholder} ${autocomplete} ${ariaLabel}`;

      const maxLength = effectiveMaxLength(input);
      const lengthMatch = (CONFIG.targetLengths as readonly number[]).includes(maxLength);
      const numericMode =
        inputmode === 'numeric' ||
        inputmode === 'tel' ||
        input.type === 'tel' ||
        input.type === 'number';

      // 1) 强信号：W3C 标准 2FA autocomplete，直接认定（优先级最高，不参与排除词过滤）
      if (autocomplete.includes('one-time-code') || autocomplete.includes('otp')) {
        return true;
      }

      // 2) 排除明显的密码 / 非 2FA 输入框
      if (CONFIG.excludeKeywords.some((keyword) => allText.includes(keyword))) {
        return false;
      }

      // 3) 中信号：numeric/tel 输入 + 长度 6/8（主流 2FA 输入框形态）
      if (numericMode && lengthMatch) {
        return true;
      }

      // 4) 弱信号：关键词命中需配合长度约束，避免凭单个泛词（auth/code/token 等）误报
      const keywordMatch = CONFIG.keywords.some((keyword) => allText.includes(keyword));
      return keywordMatch && lengthMatch;
    }

    function effectiveMaxLength(input: HTMLInputElement): number {
      const attr = input.getAttribute('maxlength');
      if (attr) {
        const parsed = Number.parseInt(attr, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          return parsed;
        }
      }
      return input.maxLength > 0 ? input.maxLength : 0;
    }

    function isSplitInput(input: HTMLInputElement): boolean {
      const maxLength = effectiveMaxLength(input);
      return maxLength >= 1 && maxLength <= CONFIG.splitMaxLength;
    }

    function ancestorChainWithin(el: Element, depth: number): Set<Element> {
      const set = new Set<Element>();
      let cur: Element | null = el.parentElement;
      let d = 0;
      while (cur && d < depth) {
        set.add(cur);
        cur = cur.parentElement;
        d += 1;
      }
      return set;
    }

    /** 两个元素是否在 depth 层内有共同祖先（用于判定分位输入框是否同组） */
    function shareCloseAncestor(a: Element, b: Element, depth: number): boolean {
      const chainA = ancestorChainWithin(a, depth);
      let cur: Element | null = b.parentElement;
      let d = 0;
      while (cur && d < depth) {
        if (chainA.has(cur)) {
          return true;
        }
        cur = cur.parentElement;
        d += 1;
      }
      return false;
    }

    /**
     * 将页面上所有 2FA 输入框（DOM 顺序）聚类成组：
     * - 单个整码输入框（maxlength 6/8）→ 独立一组
     * - 相邻的分位输入框（maxlength<=2 且共同祖先相近）→ 合成一组
     */
    function clusterGroups(inputs: HTMLInputElement[]): OtpGroup[] {
      const groups: OtpGroup[] = [];
      let current: HTMLInputElement[] = [];

      const flush = () => {
        if (current.length === 0) {
          return;
        }
        groups.push({
          inputs: current,
          anchor: current[0],
          isMulti: current.length > 1
        });
        current = [];
      };

      const maxGroupSize = Math.max(...CONFIG.targetLengths);

      for (const input of inputs) {
        if (current.length === 0) {
          current.push(input);
          continue;
        }

        const prev = current[current.length - 1];
        if (
          current.length < maxGroupSize &&
          isSplitInput(input) &&
          isSplitInput(prev) &&
          shareCloseAncestor(prev, input, CONFIG.groupAncestorDepth)
        ) {
          current.push(input);
        } else {
          flush();
          current = [input];
        }
      }
      flush();
      return groups;
    }

    function createWrapper(input: HTMLInputElement) {
      const parent = input.parentNode;
      if (!(parent instanceof HTMLElement)) {
        throw new Error('Unable to wrap input without a parent element');
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'openpass-input-wrapper';
      wrapper.style.cssText = `
        position: relative;
        display: inline-block;
        width: ${Math.max(input.getBoundingClientRect().width, input.offsetWidth)}px;
      `;

      parent.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      return wrapper;
    }

    function createGroupButton(group: OtpGroup) {
      if (groupButtons.has(group.anchor)) {
        return;
      }

      const matches = getMatchingSecrets();
      if (matches.length === 0) {
        return;
      }

      const button = document.createElement('div');
      button.className = `openpass-float-btn openpass-has-secret${
        group.isMulti ? ' openpass-group' : ''
      }`;
      button.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      `;
      button.title = group.isMulti
        ? `OpenPass - 点击填充验证码 (${matches.length} 个密钥，${group.inputs.length} 位)`
        : `OpenPass - 点击填充验证码 (${matches.length} 个密钥)`;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void fillCode(group.inputs, button);
      });

      // 按钮挂在组的第一个输入框外围（多输入组置于整组左侧）
      const wrapper = createWrapper(group.inputs[0]);
      wrapper.appendChild(button);
      groupButtons.set(group.anchor, { group, wrapper, button });
    }

    function detectInputs() {
      const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
      const candidates = allInputs.filter(
        (input) => input.type !== 'hidden' && input.offsetParent !== null && is2FAInput(input)
      );

      const groups = clusterGroups(candidates);
      const liveAnchors = new Set<HTMLInputElement>();

      for (const group of groups) {
        liveAnchors.add(group.anchor);
        const existing = groupButtons.get(group.anchor);
        if (existing) {
          // DOM 可能增删了分位输入框，同步最新列表
          existing.group.inputs = group.inputs;
          existing.group.isMulti = group.isMulti;
          continue;
        }
        createGroupButton(group);
      }

      cleanupStaleGroups(liveAnchors);
    }

    function cleanupStaleGroups(liveAnchors: Set<HTMLInputElement>) {
      groupButtons.forEach((entry, anchor) => {
        const inputsLive = entry.group.inputs.some((input) => document.body.contains(input));
        if (!liveAnchors.has(anchor) || !document.body.contains(anchor) || !inputsLive) {
          removeGroupButton(anchor);
        }
      });
    }

    async function safeSendMessage(
      message: Record<string, unknown>
    ): Promise<GenerateCodeResponse | null> {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (chrome.runtime.lastError) {
          throw new Error(chrome.runtime.lastError.message);
        }

        return response as GenerateCodeResponse;
      } catch (error) {
        if ((error as Error).message?.includes('Extension context invalidated')) {
          showToast('扩展已更新，请刷新页面', 'warning');
          return null;
        }

        throw error;
      }
    }

    function formatCode(code: string) {
      if (code.length === 6) {
        return `${code.slice(0, 3)} ${code.slice(3)}`;
      }

      if (code.length === 8) {
        return `${code.slice(0, 4)} ${code.slice(4)}`;
      }

      return code;
    }

    /** 用原生 setter 写入 value，兼容 React/Vue 受控输入 */
    function setNativeValue(input: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }
    }

    function fireInputEvents(input: HTMLInputElement) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clearSelectorInterval(selector: HTMLDivElement) {
      if (!selector.dataset.intervalId) {
        return;
      }

      window.clearInterval(Number.parseInt(selector.dataset.intervalId, 10));
      delete selector.dataset.intervalId;
    }

    function startCountdown(selector: HTMLDivElement, matches: ContentSecret[]) {
      const countdownElements = selector.querySelectorAll<HTMLElement>('.openpass-countdown');
      if (countdownElements.length === 0) {
        return;
      }

      const intervalId = window.setInterval(async () => {
        if (!document.body.contains(selector)) {
          window.clearInterval(intervalId);
          return;
        }

        let needRefresh = false;

        countdownElements.forEach((element) => {
          let remaining = Number.parseInt(element.dataset.remaining || '0', 10) - 1;
          if (remaining <= 0) {
            remaining = 0;
            needRefresh = true;
          }

          element.dataset.remaining = remaining.toString();
          element.textContent = `${remaining}s`;
          element.classList.toggle('openpass-countdown-warning', remaining <= 10 && remaining > 5);
          element.classList.toggle('openpass-countdown-urgent', remaining <= 5);
        });

        if (!needRefresh) {
          return;
        }

        window.clearInterval(intervalId);

        const codeValues = selector.querySelectorAll<HTMLElement>('.openpass-code-value');
        for (let index = 0; index < matches.length; index += 1) {
          try {
            const response = await safeSendMessage({
              action: 'generateCode',
              secret: matches[index].secret,
              digits: matches[index].digits
            });

            if (!response) {
              continue;
            }

            codeValues[index].textContent = formatCode(response.code);
            countdownElements[index].dataset.remaining = response.remainingSeconds.toString();
            countdownElements[index].textContent = `${response.remainingSeconds}s`;
            countdownElements[index].classList.remove(
              'openpass-countdown-warning',
              'openpass-countdown-urgent'
            );
          } catch (error) {
            console.error('OpenPass: 刷新验证码失败', error);
          }
        }

        startCountdown(selector, matches);
      }, 1000);

      selector.dataset.intervalId = intervalId.toString();
    }

    async function doFillCode(
      inputs: HTMLInputElement[],
      button: HTMLDivElement,
      secret: ContentSecret
    ) {
      try {
        const response = await safeSendMessage({
          action: 'generateCode',
          secret: secret.secret,
          digits: secret.digits
        });

        if (!response?.code) {
          return;
        }

        if (inputs.length === 1) {
          setNativeValue(inputs[0], response.code);
          fireInputEvents(inputs[0]);
        } else {
          // 多输入组：按 DOM 顺序逐位写入
          const code = response.code;
          for (let i = 0; i < inputs.length; i += 1) {
            const input = inputs[i];
            input.focus();
            setNativeValue(input, code[i] ?? '');
            fireInputEvents(input);
          }
        }

        button.classList.add('openpass-success');
        window.setTimeout(() => button.classList.remove('openpass-success'), 1000);
        showToast('验证码已填充', 'success');
      } catch (error) {
        console.error('OpenPass: 填充失败', error);
        showToast('填充失败', 'error');
      }
    }

    async function showSecretSelector(
      inputs: HTMLInputElement[],
      button: HTMLDivElement,
      matches: ContentSecret[]
    ) {
      closeSelector();

      const selector = document.createElement('div');
      selector.className = 'openpass-selector';

      let html = '<div class="openpass-selector-header">选择要填充的密钥</div>';
      html += '<div class="openpass-selector-list">';

      const codesData: Array<GenerateCodeResponse | null> = [];
      for (const secret of matches) {
        try {
          const response = await safeSendMessage({
            action: 'generateCode',
            secret: secret.secret,
            digits: secret.digits
          });
          codesData.push(response);
        } catch {
          codesData.push(null);
        }
      }

      matches.forEach((secret, index) => {
        const codeData = codesData[index];
        const code = codeData?.code || '------';
        const remaining = codeData?.remainingSeconds || 30;
        const name = secret.name || secret.site;

        html += `
          <div class="openpass-selector-item" data-index="${index}">
            <div class="openpass-selector-info">
              <div class="openpass-selector-name">${name}</div>
              <div class="openpass-selector-site">${secret.site}</div>
            </div>
            <div class="openpass-selector-code">
              <span class="openpass-code-value">${formatCode(code)}</span>
              <span class="openpass-countdown" data-remaining="${remaining}">${remaining}s</span>
            </div>
          </div>
        `;
      });

      html += '</div>';
      selector.innerHTML = html;

      const rect = button.getBoundingClientRect();
      selector.style.top = `${rect.bottom + 8}px`;
      selector.style.right = `${window.innerWidth - rect.right}px`;
      document.body.appendChild(selector);

      startCountdown(selector, matches);

      selector.querySelectorAll<HTMLElement>('.openpass-selector-item').forEach((item, index) => {
        item.addEventListener('click', async (event) => {
          event.stopPropagation();
          clearSelectorInterval(selector);
          await doFillCode(inputs, button, matches[index]);
          selector.remove();
        });
      });

      const closeHandler = (event: MouseEvent) => {
        const target = event.target;
        if (target instanceof Node && !selector.contains(target)) {
          clearSelectorInterval(selector);
          selector.remove();
          document.removeEventListener('click', closeHandler);
        }
      };

      window.setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    async function fillCode(inputs: HTMLInputElement[], button: HTMLDivElement) {
      const matches = getMatchingSecrets();

      if (matches.length === 0) {
        showToast('未找到当前网站的密钥', 'error');
        return;
      }

      if (matches.length > 1) {
        await showSecretSelector(inputs, button, matches);
        return;
      }

      await doFillCode(inputs, button, matches[0]);
    }

    function updateAllButtons() {
      if (getMatchingSecrets().length === 0) {
        removeAllButtons();
        return;
      }
      detectInputs();
    }

    function removeGroupButton(anchor: HTMLInputElement) {
      const entry = groupButtons.get(anchor);
      if (!entry) {
        return;
      }

      const { wrapper, group } = entry;
      const firstInput = group.inputs[0];
      const parent = wrapper.parentNode;
      if (parent instanceof Node && firstInput && wrapper.contains(firstInput)) {
        parent.insertBefore(firstInput, wrapper);
      }

      wrapper.remove();
      groupButtons.delete(anchor);
    }

    function showToast(message: string, type = 'default') {
      const oldToast = document.querySelector('.openpass-toast');
      oldToast?.remove();

      const toast = document.createElement('div');
      toast.className = `openpass-toast openpass-toast-${type}`;
      toast.textContent = message;
      document.body.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.add('openpass-toast-show');
      });

      window.setTimeout(() => {
        toast.classList.remove('openpass-toast-show');
        window.setTimeout(() => toast.remove(), 300);
      }, 2000);
    }

    function init() {
      void fetchSecrets();

      chrome.storage.onChanged.addListener((changes) => {
        if (changes.secrets) {
          void fetchSecrets();
        }
      });

      observeUrlChange();
      startDetection();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
});

const CONTENT_STYLES = String.raw`
.openpass-input-wrapper { position: relative; display: inline-block; }

/* 浮动填充按钮 */
.openpass-float-btn {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: #4f46e5;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.9;
  box-shadow: 0 2px 8px rgba(79, 70, 229, 0.35);
  transition: background 0.2s, opacity 0.2s, transform 0.15s;
  z-index: 2147483646;
}
.openpass-float-btn:hover { background: #4338ca; opacity: 1; transform: translateY(-50%) scale(1.08); }
.openpass-float-btn:active { transform: translateY(-50%) scale(0.95); }
.openpass-float-btn svg { width: 16px; height: 16px; pointer-events: none; }
.openpass-float-btn.openpass-success { background: #10b981; }
/* 多输入分组：按钮置于整组左侧外围 */
.openpass-float-btn.openpass-group { right: auto; left: -34px; }

/* 密钥选择弹层 */
.openpass-selector {
  position: fixed;
  width: 280px;
  max-height: 320px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
  z-index: 2147483647;
  color: #1e293b;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
.openpass-selector-header {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid #f1f5f9;
}
.openpass-selector-list { padding: 6px; }
.openpass-selector-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.openpass-selector-item:hover { background: #f8fafc; }
.openpass-selector-info { flex: 1; min-width: 0; }
.openpass-selector-name {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.openpass-selector-site {
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.openpass-selector-code { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.openpass-code-value {
  font-size: 15px;
  font-weight: 700;
  font-family: 'SF Mono', Consolas, Monaco, monospace;
  color: #4f46e5;
  letter-spacing: 1px;
}
.openpass-countdown {
  font-size: 11px;
  font-weight: 600;
  color: #4f46e5;
  background: #eef2ff;
  padding: 1px 7px;
  border-radius: 999px;
}
.openpass-countdown.openpass-countdown-warning { color: #d97706; background: #fef3c7; }
.openpass-countdown.openpass-countdown-urgent { color: #dc2626; background: #fee2e2; }

/* Toast */
.openpass-toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%) translateY(-20px);
  padding: 10px 18px;
  background: #1e293b;
  color: #fff;
  border-radius: 8px;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 2147483647;
  opacity: 0;
  transition: all 0.3s ease;
}
.openpass-toast.openpass-toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }
.openpass-toast.openpass-toast-success { background: #10b981; }
.openpass-toast.openpass-toast-error { background: #ef4444; }
.openpass-toast.openpass-toast-warning { background: #f59e0b; color: #1e293b; }
.openpass-toast.openpass-toast-default { background: #1e293b; }
`;
