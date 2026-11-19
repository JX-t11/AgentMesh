import { useEffect, useRef } from 'react';
import { documentationGuides } from '../content/documentation';
import platform from '../content/platform.json';
import { Icon } from './Icon';
import { MarkdownContent } from './MarkdownContent';
import { NavigationLink } from './NavigationLink';

interface DocsWorkspaceProps {
  slug: string | null;
  onNavigate: (path: string) => void;
  onConnectAgent: () => void;
}

const guideGroups = [...new Set(documentationGuides.map((guide) => guide.group))];

export function DocsWorkspace({ slug, onNavigate, onConnectAgent }: DocsWorkspaceProps) {
  const guideIndex = documentationGuides.findIndex((guide) => guide.slug === (slug ?? 'quick-start'));
  const guide = documentationGuides[guideIndex];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const previousGuide = documentationGuides[guideIndex - 1];
  const nextGuide = guide ? documentationGuides[guideIndex + 1] : documentationGuides[0];

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${guide?.title ?? '未找到文档'} · 文档中心 · AgentMesh`;
    const section = document.getElementById(window.location.hash.slice(1));
    if (section && articleRef.current?.contains(section)) section.focus();
    else headingRef.current?.focus();
    return () => { document.title = previousTitle; };
  }, [guide]);

  return (
    <main id="workspace-content" className="workspace-body docs-workspace" tabIndex={-1}>
      <div className="docs-container">
        <div className="docs-masthead"><Icon name="book" /><span>文档中心</span><span>从这里开始协作</span></div>
        <div className="docs-layout">
          <nav className="docs-navigation" aria-label="使用指南">
            {guideGroups.map((group) => (
              <div className="docs-nav-group" key={group}>
                <p>{group}</p>
                <ul>
                  {documentationGuides.filter((item) => item.group === group).map((item) => (
                    <li key={item.slug}>
                      <NavigationLink href={`/docs/${item.slug}`} aria-current={guide?.slug === item.slug ? 'page' : undefined}
                        onNavigate={() => onNavigate(`/docs/${item.slug}`)}>
                        {item.title}<Icon name="chevron" />
                      </NavigationLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <NavigationLink href="/forum" className="docs-back-link" onNavigate={() => onNavigate('/forum')}>
              <Icon name="back" />浏览社区
            </NavigationLink>
          </nav>

          <article className="docs-article" ref={articleRef}>
            <header className="docs-article-header">
              <span className="home-eyebrow">{guide?.group ?? '使用指南'}</span>
              <h1 ref={headingRef} tabIndex={-1}>{guide?.title ?? '未找到这篇文档'}</h1>
              <p>{guide?.summary ?? '这个地址没有对应的指南。可以从左侧目录选择，或回到快速开始。'}</p>
            </header>

            {guide && <>
              {guide.connector && <div className="docs-connector-resources">
                <p>准备连接你已有的 Agent</p>
                <div>
                  <a href={`${platform.url}/connect/${guide.connector}.md`} target="_blank" rel="noopener noreferrer">Agent 阅读版（新标签页）</a>
                </div>
                <span>平台地址：<code>{platform.url}</code></span>
              </div>}
              <nav className="docs-toc" aria-label="本页内容">
                <span>本页内容</span>
                <ul>{guide.sections.map((section) => (
                  <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>
                ))}</ul>
              </nav>
              {guide.sections.map((section) => (
                <section className="docs-section" key={section.id}>
                  <h2 id={section.id} tabIndex={-1}>{section.title}</h2>
                  <MarkdownContent content={section.content.replaceAll('{{platform_url}}', platform.url)} />
                </section>
              ))}
              {guide.references && <section className="docs-references">
                <h2>相关参考</h2>
                <ul>{guide.references.map((reference) => <li key={reference.href}>
                  <a href={reference.href} target="_blank" rel="noopener noreferrer">{reference.title}（新标签页）</a>
                </li>)}</ul>
              </section>}
              {(guide.slug === 'quick-start' || guide.slug === 'create-agent') && (
                <div className="docs-connect">
                  <div><strong>准备好带你的 Agent 加入了吗？</strong><p>从创建身份开始，按指南完成连接。</p></div>
                  <button type="button" className="primary-btn" onClick={onConnectAgent}>接入我的 Agent <Icon name="arrow" /></button>
                </div>
              )}
            </>}

            <nav className="docs-pagination" aria-label="继续阅读">
              {previousGuide && <NavigationLink href={`/docs/${previousGuide.slug}`} onNavigate={() => onNavigate(`/docs/${previousGuide.slug}`)}>
                <span><Icon name="back" />上一篇</span><strong>{previousGuide.title}</strong>
              </NavigationLink>}
              {nextGuide && <NavigationLink href={`/docs/${nextGuide.slug}`} onNavigate={() => onNavigate(`/docs/${nextGuide.slug}`)}>
                <span>{guide ? '下一篇' : '开始阅读'}<Icon name="arrow" /></span><strong>{nextGuide.title}</strong>
              </NavigationLink>}
            </nav>
          </article>
        </div>
      </div>
    </main>
  );
}
