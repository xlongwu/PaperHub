import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getUserPreferences } from "./lib/api";

export type SummaryLanguage = "zh" | "en";

const SUMMARY_LANGUAGE_STORAGE_KEY = "paperhub:summary_lang";

interface SummaryLanguageContextValue {
  language: SummaryLanguage;
  setLanguage: (language: SummaryLanguage) => void;
}

const SummaryLanguageContext = createContext<SummaryLanguageContextValue>({
  language: "zh",
  setLanguage: () => {},
});

export function SummaryLanguageProvider(props: { children: ReactNode }): JSX.Element {
  const initialStoredLanguage = readStoredSummaryLanguage();
  const [languageState, setLanguageState] = useState<{
    language: SummaryLanguage;
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
        language: normalizeSummaryLanguage(preferencesQuery.data.default_language) ?? "zh",
        hasLocalOverride: false,
      };
    });
  }, [languageState.hasLocalOverride, preferencesQuery.data]);

  useEffect(() => {
    function handleStorage(event: StorageEvent): void {
      if (event.key !== SUMMARY_LANGUAGE_STORAGE_KEY) {
        return;
      }
      const nextLanguage = normalizeSummaryLanguage(event.newValue);
      if (nextLanguage) {
        setLanguageState({ language: nextLanguage, hasLocalOverride: true });
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setLanguage = useCallback((language: SummaryLanguage) => {
    setLanguageState({ language, hasLocalOverride: true });
    try {
      localStorage.setItem(SUMMARY_LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The in-memory context still keeps the application in sync.
    }
  }, []);

  const value = useMemo(
    () => ({ language: languageState.language, setLanguage }),
    [languageState.language, setLanguage],
  );

  return <SummaryLanguageContext.Provider value={value}>{props.children}</SummaryLanguageContext.Provider>;
}

export function useSummaryLanguage(): SummaryLanguageContextValue {
  return useContext(SummaryLanguageContext);
}

function readStoredSummaryLanguage(): SummaryLanguage | null {
  try {
    const stored = localStorage.getItem(SUMMARY_LANGUAGE_STORAGE_KEY);
    const language = normalizeSummaryLanguage(stored);
    if (!language && stored !== null) {
      localStorage.removeItem(SUMMARY_LANGUAGE_STORAGE_KEY);
    }
    return language;
  } catch {
    return null;
  }
}

function normalizeSummaryLanguage(value: unknown): SummaryLanguage | null {
  return value === "zh" || value === "en" ? value : null;
}
