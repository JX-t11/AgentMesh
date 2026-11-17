import { useCallback, useEffect, useState } from 'react';

export type ResolvedColorScheme = 'light' | 'dark';
export type ColorSchemeOverride = ResolvedColorScheme | null;

export const COLOR_SCHEME_STORAGE_KEY = 'agentmesh-color-scheme';

function ensureColorSchemeMeta(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('head > meta[name="color-scheme"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'light dark';
    document.head.prepend(meta);
  }
  return meta;
}

function readStoredOverride(): ColorSchemeOverride {
  try {
    const raw = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}

function readSystemScheme(): ResolvedColorScheme {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function syncMetaContent(override: ColorSchemeOverride): void {
  const meta = ensureColorSchemeMeta();
  meta.content = override ?? 'light dark';
}

export function useColorScheme(): {
  resolvedScheme: ResolvedColorScheme;
  overrideScheme: ColorSchemeOverride;
  toggleColorScheme: () => void;
} {
  const [overrideScheme, setOverrideScheme] = useState<ColorSchemeOverride>(() => {
    const stored = readStoredOverride();
    syncMetaContent(stored);
    return stored;
  });
  const [systemScheme, setSystemScheme] = useState<ResolvedColorScheme>(readSystemScheme);

  useEffect(() => {
    syncMetaContent(overrideScheme);
  }, [overrideScheme]);

  useEffect(() => {
    const mql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const handleMediaChange = (event: MediaQueryListEvent) => {
      setSystemScheme(event.matches ? 'dark' : 'light');
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== COLOR_SCHEME_STORAGE_KEY) return;
      const next = readStoredOverride();
      syncMetaContent(next);
      setOverrideScheme(next);
    };

    mql?.addEventListener('change', handleMediaChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      mql?.removeEventListener('change', handleMediaChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const resolvedScheme: ResolvedColorScheme = overrideScheme ?? systemScheme;

  const toggleColorScheme = useCallback(() => {
    const currentSystem = readSystemScheme();
    setSystemScheme(currentSystem);
    setOverrideScheme((prev) => {
      const currentRendered = prev ?? currentSystem;
      const target: ResolvedColorScheme = currentRendered === 'dark' ? 'light' : 'dark';
      // 切回与当前系统偏好一致的方向时移除覆盖，避免把主题永久锁死在固定模式
      const nextOverride: ColorSchemeOverride = target === currentSystem ? null : target;
      try {
        if (nextOverride === null) {
          window.localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
        } else {
          window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, nextOverride);
        }
      } catch {
        // Ignore storage write errors while still updating live page state
      }
      syncMetaContent(nextOverride);
      return nextOverride;
    });
  }, []);

  return { resolvedScheme, overrideScheme, toggleColorScheme };
}
