import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useState } from "react";
import { DocumentPage } from "../pages/DocumentPage";
import { HomePage } from "../pages/HomePage";
import { SearchPage } from "../pages/SearchPage";
import { TagsPage } from "../pages/TagsPage";
import { UserCenterPage } from "../pages/UserCenterPage";
import { SUMMARY_UI } from "@/i18n";
import { SummaryLanguageProvider, useSummaryLanguage } from "../summary-language";

const navItems = [
  { to: "/", label: "Desk" },
  { to: "/search", label: "Search" },
  { to: "/tags", label: "Tags" },
  { to: "/me", label: "Profile" },
];

export function App(): JSX.Element {
  return (
    <SummaryLanguageProvider>
      <AppContent />
    </SummaryLanguageProvider>
  );
}

function AppContent(): JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { language, setLanguage } = useSummaryLanguage();

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-kicker">Paper Intelligence Desk</span>
          <NavLink className="brand-title" to="/">
            PaperHub
          </NavLink>
        </div>
        <nav className="main-nav" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
              to={item.to}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="header-tools">
          <div aria-label={SUMMARY_UI.switchLabel[language]} className="summary-language-toggle" role="group">
            <button
              aria-pressed={language === "zh"}
              className={`summary-language-button${language === "zh" ? " active" : ""}`}
              onClick={() => setLanguage("zh")}
              type="button"
            >
              {SUMMARY_UI.chinese.zh}
            </button>
            <button
              aria-pressed={language === "en"}
              className={`summary-language-button${language === "en" ? " active" : ""}`}
              onClick={() => setLanguage("en")}
              type="button"
            >
              {SUMMARY_UI.english.en}
            </button>
          </div>
          <form
            className="header-search"
            onSubmit={(event) => {
              event.preventDefault();
              const normalized = query.trim();
              navigate(normalized ? `/search?q=${encodeURIComponent(normalized)}` : "/search");
            }}
          >
            <input
              aria-label="Global search"
              className="search-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search papers, themes, models"
              value={query}
            />
            <button className="search-button" type="submit">
              Open search
            </button>
          </form>
        </div>
      </header>

      <main className="app-main">
        <Routes>
          <Route element={<HomePage />} path="/" />
          <Route element={<SearchPage />} path="/search" />
          <Route element={<DocumentPage />} path="/documents/:id" />
          <Route element={<TagsPage />} path="/tags" />
          <Route element={<TagsPage />} path="/tags/:tag" />
          <Route element={<UserCenterPage />} path="/me" />
        </Routes>
      </main>
    </div>
  );
}
