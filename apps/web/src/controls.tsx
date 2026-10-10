import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronUp } from "lucide-react";
import { Icon } from "./ui";

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
          <Icon.chevronDown />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="pop select-menu"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <SelectPrimitive.ScrollUpButton className="pop-scroll">
            <ChevronUp size={16} aria-hidden="true" />
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
                className="pop-item"
              >
                <span className="grow">
                  <SelectPrimitive.ItemText>
                    {option.props.children}
                  </SelectPrimitive.ItemText>
                </span>
                <SelectPrimitive.ItemIndicator className="end">
                  <Icon.check size={14} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="pop-scroll">
            <Icon.chevronDown />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

type Theme = "system" | "light" | "dark";
export function ThemeMenu({ bordered }: { bordered?: boolean }) {
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
  const ThemeIcon =
    theme === "light" ? Icon.sun : theme === "dark" ? Icon.moon : Icon.monitor;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className={`icon-btn${bordered ? " bordered" : ""}`}
        aria-label="外観を変更"
        title="外観を変更"
      >
        <ThemeIcon size={18} />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className="pop"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <Dropdown.Label className="pop-label">
            <strong>外観</strong>
          </Dropdown.Label>
          <Dropdown.RadioGroup
            value={theme}
            onValueChange={(next) => setTheme(next as Theme)}
          >
            {(
              [
                { value: "light", label: "ライト", icon: Icon.sun },
                { value: "dark", label: "ダーク", icon: Icon.moon },
                { value: "system", label: "システム", icon: Icon.monitor },
              ] as const
            ).map((item) => (
              <Dropdown.RadioItem
                key={item.value}
                value={item.value}
                className="pop-item"
              >
                <item.icon />
                <span className="grow">{item.label}</span>
                <Dropdown.ItemIndicator className="end">
                  <Icon.check size={14} />
                </Dropdown.ItemIndicator>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
