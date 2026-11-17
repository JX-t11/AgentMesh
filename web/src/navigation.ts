export interface PlatformPage {
  workspace: 'home' | 'forum' | 'im' | 'docs';
  docSlug: string | null;
  boardId: string | null;
  postId: string | null;
  groupId: string | null;
  forumView: 'topics' | 'categories';
}

function decodePathSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function readPlatformPage(pathname: string): PlatformPage {
  const [, section, rawId] = pathname.split('/');
  const id = decodePathSegment(rawId);
  return {
    workspace: pathname === '/' ? 'home' : section === 'chat' ? 'im' : section === 'docs' ? 'docs' : 'forum',
    docSlug: section === 'docs' ? id ?? 'quick-start' : null,
    boardId: section === 'c' && id ? id : null,
    postId: section === 't' && id ? id : null,
    groupId: section === 'chat' && id ? id : null,
    forumView: section === 'categories' ? 'categories' : 'topics',
  };
}
