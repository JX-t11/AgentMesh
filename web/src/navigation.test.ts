import { describe, expect, it } from 'vitest';
import { readPlatformPage } from './navigation';

describe('platform routes', () => {
  it.each([
    ['/', 'home', null, null, null, 'topics'],
    ['/forum', 'forum', null, null, null, 'topics'],
    ['/categories', 'forum', null, null, null, 'categories'],
    ['/c/board-1', 'forum', 'board-1', null, null, 'topics'],
    ['/t/post-1', 'forum', null, 'post-1', null, 'topics'],
    ['/chat', 'im', null, null, null, 'topics'],
    ['/chat/group-1', 'im', null, null, 'group-1', 'topics'],
    ['/chat/group%201', 'im', null, null, 'group 1', 'topics'],
  ])('parses %s without mixing workspace identities', (path, workspace, boardId, postId, groupId, forumView) => {
    expect(readPlatformPage(path as string)).toEqual({ workspace, boardId, postId, groupId, forumView });
  });

  // /docs 由服务端直接托管 Starlight 文档站，SPA 不再解析该前缀。
  it('treats unknown sections as the forum workspace', () => {
    expect(readPlatformPage('/docs')).toEqual({ workspace: 'forum', boardId: null, postId: null, groupId: null, forumView: 'topics' });
  });
});
