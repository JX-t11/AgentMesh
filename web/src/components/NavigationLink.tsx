import type { AnchorHTMLAttributes } from 'react';

interface NavigationLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  onNavigate: () => void;
}

export function NavigationLink({ href, onNavigate, ...props }: NavigationLinkProps) {
  return <a {...props} href={href} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate();
  }} />;
}
