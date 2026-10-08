import type { App } from 'vue';
import { getErrorMessage } from '@/utils/error';

const RUNTIME_ERRORS_KEY = 'runtimeErrors';
const MAX_RUNTIME_ERRORS = 20;

const IGNORED_ERROR_PATTERNS = [
  'Extension context invalidated.',
  'context invalidated',
  'The message port closed before a response was received.',
  'message port closed'
];

export interface RuntimeErrorEntry {
  id: string;
  scope: string;
  message: string;
  details?: string;
  stack?: string;
  createdAt: string;
}

export interface ErrorEventTarget {
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void;
}

interface RuntimeErrorListenerOptions {
  ignoreExternalScriptErrors?: boolean;
}

function createErrorId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getExtensionUrlPrefix() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
      return null;
    }

    return chrome.runtime.getURL('');
  } catch {
    return null;
  }
}

function hasExtensionSource(error: unknown, filename?: string) {
  const extensionUrlPrefix = getExtensionUrlPrefix();
  if (!extensionUrlPrefix) {
    return true;
  }

  if (typeof filename === 'string' && filename.startsWith(extensionUrlPrefix)) {
    return true;
  }

  return error instanceof Error && Boolean(error.stack?.includes(extensionUrlPrefix));
}

function shouldIgnoreErrorEvent(event: ErrorEvent, options: RuntimeErrorListenerOptions) {
  return (
    options.ignoreExternalScriptErrors === true &&
    !hasExtensionSource(event.error, event.filename)
  );
}

function shouldIgnoreUnhandledRejection(event: PromiseRejectionEvent, options: RuntimeErrorListenerOptions) {
  if (options.ignoreExternalScriptErrors !== true) {
    return false;
  }

  if (event.reason instanceof Error) {
    return !hasExtensionSource(event.reason);
  }

  return true;
}

function shouldIgnoreByMessage(message: string) {
  const lowerMessage = message.toLowerCase();
  return IGNORED_ERROR_PATTERNS.some((pattern) =>
    lowerMessage.includes(pattern.toLowerCase())
  );
}

async function readRuntimeErrors(): Promise<RuntimeErrorEntry[]> {
  try {
    const result = await chrome.storage.local.get<{ runtimeErrors?: RuntimeErrorEntry[] }>([
      RUNTIME_ERRORS_KEY
    ]);
    return Array.isArray(result.runtimeErrors) ? result.runtimeErrors : [];
  } catch {
    return [];
  }
}

function createReporter(scope: string) {
  return (error: unknown, details?: string) => {
    void recordRuntimeError({ scope, error, details }).catch((recordError) => {
      if (!shouldIgnoreByMessage(getErrorMessage(recordError, ''))) {
        console.error(`[${scope}] failed to record runtime error`, recordError);
      }
    });
  };
}

export async function getRuntimeErrors() {
  return readRuntimeErrors();
}

export async function clearRuntimeErrors() {
  await chrome.storage.local.set({ [RUNTIME_ERRORS_KEY]: [] });
}

export async function recordRuntimeError(input: {
  scope: string;
  error: unknown;
  details?: string;
}) {
  const message = getErrorMessage(input.error, '未知错误');
  
  if (shouldIgnoreByMessage(message)) {
    return null;
  }

  const entry: RuntimeErrorEntry = {
    id: createErrorId(),
    scope: input.scope,
    message,
    details: input.details,
    stack: input.error instanceof Error ? input.error.stack : undefined,
    createdAt: new Date().toISOString()
  };

  const existing = await readRuntimeErrors();
  const next = [entry, ...existing].slice(0, MAX_RUNTIME_ERRORS);
  await chrome.storage.local.set({ [RUNTIME_ERRORS_KEY]: next });
  return entry;
}

export function installGlobalRuntimeErrorListeners(
  scope: string,
  target: ErrorEventTarget = window,
  options: RuntimeErrorListenerOptions = {}
) {
  const report = createReporter(scope);

  target.addEventListener('error', (event) => {
    if (shouldIgnoreErrorEvent(event, options)) {
      return;
    }

    report(event.error ?? new Error(event.message), event.filename || 'global.error');
  });

  target.addEventListener('unhandledrejection', (event) => {
    if (shouldIgnoreUnhandledRejection(event, options)) {
      return;
    }

    report(event.reason, 'unhandledrejection');
  });
}

export function installRuntimeErrorReporter(app: App<Element>, scope: string) {
  const report = createReporter(scope);
  installGlobalRuntimeErrorListeners(scope);

  const previousErrorHandler = app.config.errorHandler;
  app.config.errorHandler = (error, instance, info) => {
    report(error, `vue:${info}`);
    console.error(`[${scope}] Vue error`, error, info, instance);
    previousErrorHandler?.(error, instance, info);
  };
}
