import { isOtpInput, isOtpSplitGroup, type OtpInputSignals } from './otpInput';

const MAX_CONTEXT_DEPTH = 4;

function referencedText(input: Element, attribute: string): string {
  return (input.getAttribute(attribute) || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => input.ownerDocument.getElementById(id)?.textContent || '')
    .join(' ');
}

function maxLength(input: HTMLInputElement): number {
  const value = Number(input.getAttribute('maxlength'));
  return value > 0 ? value : 0;
}

function editableInputs(container: Element): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input')).filter((input) =>
    ['text', 'tel', 'number', 'password', 'email', 'search', 'url'].includes(input.type)
  );
}

function sharesField(inputs: HTMLInputElement[], input: HTMLInputElement): boolean {
  if (inputs.length === 1) return inputs[0] === input;
  return (
    inputs.length > 1 &&
    inputs.length <= 8 &&
    inputs.every((item) => maxLength(item) >= 1 && maxLength(item) <= 2)
  );
}

/** 最邻近的字段说明；遇到其他普通输入框或整张表单就停止向上扩散。 */
function fieldContext(input: HTMLInputElement): Element | null {
  let container = input.parentElement;
  for (let depth = 0; container && depth < MAX_CONTEXT_DEPTH; depth += 1) {
    if (
      container.matches('form, fieldset, body, html') ||
      !sharesField(editableInputs(container), input)
    )
      break;
    if (container.textContent?.trim() || container.querySelector('img, canvas')) return container;
    container = container.parentElement;
  }
  return null;
}

/** 分组采用关联说明、legend，以及只有一个代码字段的表单标题。 */
function groupInstructions(input: HTMLInputElement): string {
  const group = input.closest('fieldset, [role="group"], form');
  if (!group) return '';
  const legend = group.matches('fieldset')
    ? Array.from(group.children).find((child) => child.tagName === 'LEGEND')?.textContent || ''
    : '';
  const members = editableInputs(group);
  const heading =
    group.matches('form') && sharesField(members, input)
      ? group.querySelector('h1, h2, h3, [role="heading"]')?.textContent || ''
      : '';
  return [
    referencedText(group, 'aria-labelledby'),
    referencedText(group, 'aria-describedby'),
    legend,
    heading
  ].join(' ');
}

function hasVisibleMedia(container: Element): boolean {
  const media = container.matches('img, canvas')
    ? [container as HTMLElement]
    : Array.from(container.querySelectorAll<HTMLElement>('img, canvas'));
  return media.some((item) => {
    if (item.closest('[hidden], [aria-hidden="true"], [role="presentation"]')) return false;
    const style = item.ownerDocument.defaultView?.getComputedStyle(item);
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  });
}

function hasFieldImage(input: HTMLInputElement): boolean {
  let container = input.parentElement;
  let branch: Element = input;
  for (let depth = 0; container && depth < MAX_CONTEXT_DEPTH; depth += 1) {
    if (container.matches('body, html') || !sharesField(editableInputs(container), input)) break;
    if (container.matches('form')) {
      // 表单前置图片通常属于页头；字段内图片和字段后紧邻的挑战图才关联。
      const sibling = branch.nextElementSibling;
      return Boolean(sibling && hasVisibleMedia(sibling));
    }
    if (hasVisibleMedia(container)) return true;
    branch = container;
    container = container.parentElement;
  }
  return false;
}

function isCodeStep(input: HTMLInputElement): boolean {
  const group = input.form || input.closest('fieldset, [role="group"], [role="form"]');
  if (group) {
    return (
      sharesField(editableInputs(group), input) &&
      Boolean(
        group.querySelector('button:not([type="button"]):not([type="reset"]), input[type="submit"]')
      )
    );
  }
  let container = input.parentElement;
  for (let depth = 0; container && depth < MAX_CONTEXT_DEPTH; depth += 1) {
    if (container.matches('body, html') || !sharesField(editableInputs(container), input)) break;
    if (container.querySelector('button[type="submit"], input[type="submit"]')) return true;
    container = container.parentElement;
  }
  return false;
}

export function collectOtpInputSignals(input: HTMLInputElement): OtpInputSignals {
  const context = fieldContext(input);
  return {
    type: input.type,
    name: input.name,
    id: input.id,
    placeholder: input.placeholder,
    autocomplete: input.autocomplete,
    ariaLabel: input.getAttribute('aria-label') || '',
    labelText: [
      Array.from(input.labels || [])
        .map((label) => label.textContent || '')
        .join(' '),
      referencedText(input, 'aria-labelledby')
    ].join(' '),
    descriptionText: referencedText(input, 'aria-describedby'),
    inputMode: input.getAttribute('inputmode') || '',
    maxLength: maxLength(input),
    pattern: input.pattern,
    isCodeStep: isCodeStep(input),
    contextText: [context?.textContent || '', groupInstructions(input)].join(' '),
    hasAdjacentImage: hasFieldImage(input)
  };
}

export interface DetectedOtpGroup {
  inputs: HTMLInputElement[];
  anchor: HTMLInputElement;
  isMulti: boolean;
}

function splitGroup(input: HTMLInputElement): HTMLInputElement[] | null {
  let container = input.parentElement;
  for (let depth = 0; container && depth < MAX_CONTEXT_DEPTH; depth += 1) {
    if (container.matches('body, html')) break;
    const inputs = editableInputs(container);
    if (inputs.length > 8 || inputs.some((item) => maxLength(item) < 1 || maxLength(item) > 2))
      break;
    if ([6, 8].includes(inputs.length)) return inputs;
    container = container.parentElement;
  }
  return null;
}

/** 先按实际字段容器收集分位框，再分类；不把筛选后碰巧相邻的框拼在一起。 */
export function detectOtpInputGroups(inputs: HTMLInputElement[]): DetectedOtpGroup[] {
  const eligible = new Set(inputs);
  const visited = new Set<HTMLInputElement>();
  const groups: DetectedOtpGroup[] = [];
  for (const input of inputs) {
    if (visited.has(input)) continue;
    if (maxLength(input) >= 1 && maxLength(input) <= 2) {
      const members = splitGroup(input);
      if (
        !members ||
        !members.every((member) => eligible.has(member)) ||
        !isOtpSplitGroup(members.map(collectOtpInputSignals))
      )
        continue;
      members.forEach((member) => visited.add(member));
      groups.push({ inputs: members, anchor: members[0], isMulti: true });
    } else if (isOtpInput(collectOtpInputSignals(input))) {
      groups.push({ inputs: [input], anchor: input, isMulti: false });
    }
  }
  return groups;
}
