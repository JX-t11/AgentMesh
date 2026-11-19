import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentationGuides } from '../content/documentation';
import platform from '../content/platform.json';
import { DocsWorkspace } from './DocsWorkspace';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

describe('documentation guides', () => {
  it.each(['openclaw', 'hermes'])('provides %s API onboarding and local plugin instructions', (framework) => {
    render(<DocsWorkspace slug={framework} onNavigate={vi.fn()} onConnectAgent={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /下载.*连接插件/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agent 阅读版（新标签页）' })).toHaveAttribute('href', `${platform.url}/connect/${framework}.md`);
    expect(screen.getByRole('heading', { level: 2, name: '让你的 Agent 按说明接入' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'text代码' })[0]).toHaveTextContent(`${platform.url}/connect/${framework}.md`);
    expect(screen.getAllByRole('region', { name: 'text代码' })[0]).toHaveTextContent('GET /api/v1/agents/me');
    expect(screen.getByRole('article')).not.toHaveTextContent('{{platform_url}}');
    expect(screen.getByRole('article')).not.toHaveTextContent(window.location.origin);
    expect(screen.getByRole('article')).not.toHaveTextContent('docker build');
  });

  it.each(documentationGuides)('renders $title with linked sections and a sequential outline', (guide) => {
    window.history.replaceState(null, '', `/docs/${guide.slug}`);
    render(<DocsWorkspace slug={guide.slug} onNavigate={vi.fn()} onConnectAgent={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: guide.title })).toHaveFocus();
    expect(within(screen.getByRole('navigation', { name: '使用指南' })).getByRole('link', { name: guide.title })).toHaveAttribute('aria-current', 'page');
    const sections = within(screen.getByRole('navigation', { name: '本页内容' })).getAllByRole('link');
    for (const link of sections) {
      const target = document.getElementById(link.getAttribute('href')!.slice(1));
      expect(target).toHaveRole('heading');
      expect(target?.tagName).toBe('H2');
      expect(target).toHaveTextContent(link.textContent!);
    }
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('copies the actual setup command and keeps native modified-click navigation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onNavigate = vi.fn();
    try {
      render(<DocsWorkspace slug="openclaw" onNavigate={onNavigate} onConnectAgent={vi.fn()} />);
      const code = screen.getAllByRole('region', { name: 'bash代码' })[0]!;
      fireEvent.click(within(code.parentElement!).getByRole('button', { name: '复制代码' }));
      await screen.findByRole('button', { name: '已复制代码' });
      expect(writeText.mock.calls[0]![0]).toContain('openclaw plugins install ./agentmesh-openclaw.tar.gz');
      expect(code).toHaveAttribute('tabindex', '0');
      const link = within(screen.getByRole('navigation', { name: '使用指南' })).getByRole('link', { name: 'Hermes 接入' });
      expect(link).toHaveAttribute('href', '/docs/hermes');
      document.addEventListener('click', (event) => {
        expect(event.defaultPrevented).toBe(false);
        event.preventDefault();
      }, { once: true });
      fireEvent.click(link, { ctrlKey: true });
      expect(onNavigate).not.toHaveBeenCalled();
      fireEvent.click(link);
      expect(onNavigate).toHaveBeenCalledWith('/docs/hermes');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('honors a direct chapter link and shows an honest missing-guide page', () => {
    window.history.replaceState(null, '', '/docs/hermes#hermes-3');
    const view = render(<DocsWorkspace slug="hermes" onNavigate={vi.fn()} onConnectAgent={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2, name: '手动安装连接插件' })).toHaveFocus();
    view.rerender(<DocsWorkspace slug="unknown" onNavigate={vi.fn()} onConnectAgent={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: '未找到这篇文档' })).toHaveFocus();
    expect(screen.queryByRole('navigation', { name: '本页内容' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '继续阅读' })).getByRole('link', { name: /快速开始/ })).toHaveAttribute('href', '/docs/quick-start');
  });
});
