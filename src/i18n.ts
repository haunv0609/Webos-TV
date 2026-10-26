// i18n — initializes i18next with bundled locale resources.
// Import this module in main.tsx (before React renders) so t() is ready on first render.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import vi from './locales/vi.json';
import en from './locales/en.json';

// Read the persisted language from localStorage before any store is created.
// Matches the 'zui-settings' zustand persist key used by settingsStore.
function getPersistedLanguage(): string {
  try {
    const raw = localStorage.getItem('zui-settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { language?: string } };
      const lang = parsed.state?.language;
      if (lang && ['vi', 'en'].includes(lang)) return lang;
    }
  } catch { /* ignore – localStorage may be unavailable */ }
  return 'vi';
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      vi: { translation: vi },
      en: { translation: en },
    },
    lng: getPersistedLanguage(),
    fallbackLng: 'vi',
    interpolation: {
      escapeValue: false, // React already escapes
    },
  });

export default i18n;
