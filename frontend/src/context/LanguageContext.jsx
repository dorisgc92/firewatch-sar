import { createContext, useContext, useState, useMemo } from "react"
import { detectLanguage, translate } from "../utils/i18n"

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const detected = useMemo(() => detectLanguage(), [])
  const [lang, setLang] = useState(detected)

  const value = useMemo(() => ({
    lang,
    setLang,
    detected,
    t: (key, vars) => translate(lang, key, vars),
  }), [lang, detected])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error("useLanguage must be used within a LanguageProvider")
  return ctx
}
