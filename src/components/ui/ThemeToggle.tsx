import React, { useEffect } from 'react'
import { Sun, Moon } from 'lucide-react'
import { useStore } from '@nanostores/react'
import { Button } from './button'
import { $theme, initThemeFromStorage, setTheme, applyThemeToDocument } from '@/modules/stores/$theme'

export function ThemeToggle() {
  const theme = useStore($theme)

  useEffect(() => {
    initThemeFromStorage()
    applyThemeToDocument(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    applyThemeToDocument(theme)
  }, [theme])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
  }

  return (
    <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle theme">
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </Button>
  )
}
