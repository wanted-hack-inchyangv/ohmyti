import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

/**
 * 버튼·링크 버튼. primary는 파란 채움(화면당 주요 동작 하나), secondary는 회색 테두리, ghost는 배경 없음.
 * 판정 색(fail·pending)은 쓰지 않는다.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "dark";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-surface hover:bg-primary-strong disabled:bg-neutral-200 disabled:text-neutral-400",
  secondary:
    "border border-neutral-300 bg-surface text-ink hover:bg-neutral-50 disabled:text-neutral-400",
  ghost: "text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400",
  dark: "bg-ink text-surface hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return `inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]}`;
}

export function Button({
  variant,
  size,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button {...rest} className={`${buttonClass(variant, size)} ${className ?? ""}`} />;
}

export function LinkButton({
  variant,
  size,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a {...rest} className={`${buttonClass(variant, size)} ${className ?? ""}`} />;
}
