import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getUserPreferences } from "./lib/api";

export type AppLanguage = "zh" | "en";

const APP_LANGUAGE_STORAGE_KEY = "paperhub:summary_lang";

interface AppLanguageContextValue {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
}

const AppLanguageContext = createContext<AppLanguageContextValue>({
  language: "zh",
  setLanguage: () => {},
});

export function AppLanguageProvider(props: { children: ReactNode }): JSX.Element {
  const initialStoredLanguage = readStoredAppLanguage();
  const [languageState, setLanguageState] = useState<{
    language: AppLanguage;
    hasLocalOverride: boolean;
  }>({
    language: initialStoredLanguage ?? "zh",
    hasLocalOverride: initialStoredLanguage !== null,
  });
  const preferencesQuery = useQuery({
    queryKey: ["user", "preferences"],
    queryFn: getUserPreferences,
  });

  useEffect(() => {
    if (languageState.hasLocalOverride || !preferencesQuery.data) {
      return;
    }

    setLanguageState((current) => {
      if (current.hasLocalOverride) {
        return current;
      }
      return {
        language: normalizeAppLanguage(preferencesQuery.data.default_language) ?? "zh",
        hasLocalOverride: false,
      };
    });
  }, [languageState.hasLocalOverride, preferencesQuery.data]);

  useEffect(() => {
    function handleStorage(event: StorageEvent): void {
      if (event.key !== APP_LANGUAGE_STORAGE_KEY) {
        return;
      }
      const nextLanguage = normalizeAppLanguage(event.newValue);
      if (nextLanguage) {
        setLanguageState({ language: nextLanguage, hasLocalOverride: true });
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setLanguage = useCallback((language: AppLanguage) => {
    setLanguageState({ language, hasLocalOverride: true });
    try {
      localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The in-memory context still keeps the application in sync.
    }
  }, []);

  const value = useMemo(
    () => ({ language: languageState.language, setLanguage }),
    [languageState.language, setLanguage],
  );

  return <AppLanguageContext.Provider value={value}>{props.children}</AppLanguageContext.Provider>;
}

export function useAppLanguage(): AppLanguageContextValue {
  return useContext(AppLanguageContext);
}

/** @deprecated Use useAppLanguage instead. */
export const useSummaryLanguage = useAppLanguage;
/** @deprecated Use AppLanguage instead. */
export type SummaryLanguage = AppLanguage;

function readStoredAppLanguage(): AppLanguage | null {
  try {
    const stored = localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    const language = normalizeAppLanguage(stored);
    if (!language && stored !== null) {
      localStorage.removeItem(APP_LANGUAGE_STORAGE_KEY);
    }
    return language;
  } catch {
    return null;
  }
}

function normalizeAppLanguage(value: unknown): AppLanguage | null {
  return value === "zh" || value === "en" ? value : null;
}
