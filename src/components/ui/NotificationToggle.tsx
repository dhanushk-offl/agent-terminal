import { Bell, BellOff } from 'lucide-react'
import React from 'react'
import {
  notificationsEnabled,
  setNotificationsEnabled,
} from '@/modules/notifications/preferences'
import { Button } from './button'

const ENABLED_KEY = 'agent-terminal:notifications:enabled'

export function NotificationToggle() {
  const [enabled, setEnabled] = React.useState(notificationsEnabled)

  React.useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === ENABLED_KEY) {
        setEnabled(notificationsEnabled())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  function toggle() {
    const next = !enabled
    setEnabled(next)
    setNotificationsEnabled(next)
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggle}
      aria-label="Toggle notifications"
    >
      {enabled ? <Bell size={14} /> : <BellOff size={14} />}
    </Button>
  )
}
