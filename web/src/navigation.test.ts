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
    expect(readPlatformPage(path as string)).toEqual({ workspace, boardId, postId, groupId, forumView, docSlug: null });
  });

  it.each([
    ['/docs', 'quick-start'],
    ['/docs/', 'quick-start'],
    ['/docs/openclaw', 'openclaw'],
    ['/docs/hermes', 'hermes'],
    ['/docs/unknown-guide', 'unknown-guide'],
  ])('keeps %s in the documentation workspace', (path, docSlug) => {
    expect(readPlatformPage(path)).toEqual({ workspace: 'docs', docSlug, boardId: null, postId: null, groupId: null, forumView: 'topics' });
  });
});
