import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/**
 * Every word the portal shows lives in a message catalogue from day one, even
 * with English alone: adding Hindi or a regional language is then a new file,
 * not a rewrite (sp5-plan.md, DF8).
 */
export const LANGUAGES = ['en'] as const;

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  // React escapes what it renders.
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
