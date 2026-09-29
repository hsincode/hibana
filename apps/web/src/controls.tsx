import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";

type OptionProps = { value: string; disabled?: boolean; children: ReactNode };
const EMPTY = "__hibana_empty__";

export function Select({
  id,
  value,
  onValueChange,
  children,
  disabled,
  required,
  ...label
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
}) {
  const options = Children.toArray(children).filter(
    isValidElement<OptionProps>,
  );
  const placeholder = options.find((option) => option.props.value === "")?.props
    .children;
  return (
    <SelectPrimitive.Root
      value={value || (required ? "" : EMPTY)}
      onValueChange={(next) => onValueChange(next === EMPTY ? "" : next)}
      disabled={disabled}
      required={required}
    >
      <SelectPrimitive.Trigger id={id} className="select-trigger" {...label}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown size={16} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="select-menu"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <SelectPrimitive.ScrollUpButton className="select-scroll">
            <ChevronUp size={16} />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.props.value}
                value={option.props.value || EMPTY}
                disabled={
                  option.props.disabled ||
                  (required && option.props.value === "")
                }
                className="select-item"
              >
                <SelectPrimitive.ItemText>
                  {option.props.children}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={16} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="select-scroll">
            <ChevronDown size={16} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

type Theme = "system" | "light" | "dark";
export function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem("hibana-theme");
      return stored === "dark" || stored === "light" ? stored : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("hibana-theme", theme);
    } catch {
      /* Storage can be unavailable in private browsers. */
    }
  }, [theme]);
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className="btn btn-ghost icon-button"
        aria-label="外観を変更"
        title="外観を変更"
      >
        <ThemeIcon size={19} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className="dropdown-menu"
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          <Dropdown.Label className="dropdown-label">外観</Dropdown.Label>
          <Dropdown.RadioGroup
            value={theme}
            onValueChange={(next) => setTheme(next as Theme)}
          >
            {(
              [
                { value: "light", label: "ライト", icon: Sun },
                { value: "dark", label: "ダーク", icon: Moon },
                { value: "system", label: "システム", icon: Monitor },
              ] as const
            ).map((item) => (
              <Dropdown.RadioItem
                key={item.value}
                value={item.value}
                className="dropdown-item"
              >
                <item.icon size={16} />
                {item.label}
                <Dropdown.ItemIndicator className="menu-check">
                  <Check size={16} />
                </Dropdown.ItemIndicator>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
