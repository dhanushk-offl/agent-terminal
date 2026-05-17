import { useStore } from '@nanostores/react'
import { ChevronDown, Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { $theme, setTheme, type Theme } from '@/modules/stores/theme'
import { buttonVariants } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip'

const OPTIONS: Array<{
  value: Theme
  label: string
  icon: typeof Sun
}> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

function getThemeMeta(theme: Theme) {
  return OPTIONS.find((option) => option.value === theme) ?? OPTIONS[0]
}

export function ThemeToggle() {
  const theme = useStore($theme)
  const meta = getThemeMeta(theme)
  const CurrentIcon = meta.icon

  return (
    <TooltipProvider delay={250}>
      <Tooltip>
        <TooltipTrigger
          render={(triggerProps) => (
            <span
              {...triggerProps}
              className={cn('inline-flex', triggerProps.className)}
              style={triggerProps.style}
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(menuTriggerProps) => (
                    <span
                      {...menuTriggerProps}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'sm' }),
                        'gap-1.5 px-2.5 font-medium text-[11px] text-muted-foreground',
                        menuTriggerProps.className,
                      )}
                      style={{
                        fontFamily: 'var(--font-ui)',
                        ...(menuTriggerProps.style ?? {}),
                      }}
                    >
                      <CurrentIcon
                        size={14}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                      <ChevronDown
                        size={12}
                        aria-hidden="true"
                        className={cn(
                          'origin-center opacity-60 transition-transform duration-150',
                          'data-open:rotate-180',
                        )}
                      />
                    </span>
                  )}
                  aria-label="Theme settings"
                  nativeButton={false}
                />

                <DropdownMenuContent
                  align="end"
                  side="bottom"
                  sideOffset={8}
                  className="min-w-32 p-0.5"
                  style={{ fontFamily: 'var(--font-ui)' }}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="px-1.5 pt-1 pb-0.5 font-semibold text-[9px] uppercase leading-none tracking-[0.16em]">
                      Theme
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {OPTIONS.map((option) => {
                      const Icon = option.icon
                      const checked = theme === option.value
                      return (
                        <DropdownMenuItem
                          key={option.value}
                          onClick={() => setTheme(option.value)}
                          className="w-full justify-between gap-2 py-0.5 pr-1.5 text-[11px]"
                        >
                          <span className="flex items-center gap-1.5">
                            <Icon
                              aria-hidden="true"
                              size={12}
                              className="shrink-0"
                            />
                            {option.label}
                          </span>
                          <span
                            aria-hidden="true"
                            className={cn(
                              'text-foreground/70 transition-opacity',
                              checked ? 'opacity-100' : 'opacity-0',
                            )}
                          >
                            ✓
                          </span>
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )}
          aria-label="Theme settings"
        />
        <TooltipContent
          side="top"
          sideOffset={4}
          showArrow={false}
          className="rounded-md border border-border bg-popover px-2 py-0.5 text-[10px] text-popover-foreground shadow-sm"
          style={{ fontFamily: 'var(--font-ui)' }}
        >
          Theme
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
