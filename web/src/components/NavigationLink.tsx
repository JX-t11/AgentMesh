import type { AnchorHTMLAttributes } from 'react';

interface NavigationLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  onNavigate: () => void;
}

export function NavigationLink({ onNavigate, ...props }: NavigationLinkProps) {
  return <a {...props} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate();
  }} />;
}
