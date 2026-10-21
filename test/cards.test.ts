/**
 * Permission cards: what a tool will do, and the embed it's shown in.
 * Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test'
import { toolPreview, cardEmbed } from '../src/cards'
import { setLanguage } from '../src/i18n'

setLanguage('en')

describe('toolPreview', () => {
  test('Bash: the command', () => {
    expect(toolPreview('Bash', { command: 'rm -rf build', description: 'Clean' })).toBe('```bash\nrm -rf build\n```')
  })
  test('Write: path and content with its language, not JSON', () => {
    const out = toolPreview('Write', { file_path: '/p/a.ts', content: 'const x = 1\nconst y = 2\n' })
    expect(out).toBe('📄 `/p/a.ts`\n```ts\nconst x = 1\nconst y = 2\n```')
    expect(out).not.toContain('\\n')
  })
  test('Write: long content is cut with a line count', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const out = toolPreview('Write', { file_path: '/p/a.txt', content })
    expect(out).toContain('line 19')
    expect(out).not.toContain('line 20')
    expect(out).toContain('… (30 lines)')
  })
  test('Edit: a diff', () => {
    expect(toolPreview('Edit', { file_path: '/p/a.py', old_string: 'x = 1', new_string: 'x = 2' })).toBe('✏️ `/p/a.py`\n```diff\n- x = 1\n+ x = 2\n```')
  })
  test('MCP tool: server, tool and input', () => {
    const out = toolPreview('mcp__github__create_issue', { title: 't' })
    expect(out.split('\n')[0]).toBe('🔌 github · create_issue')
    expect(out).toContain('"title": "t"')
  })
  test('backticks in content cannot close the fence', () => {
    expect(toolPreview('Bash', { command: 'echo ```' })).toBe('```bash\necho ˋˋˋ\n```')
  })
})

describe('cardEmbed', () => {
  test('colour by state, plain title, status appended', () => {
    const e = cardEmbed({ title: '🔐 **Permission needed: Bash**', body: 'body', footer: '-# reply `yes abcde`' }, 'approved', '-# **✅ Allowed** (me)').toJSON()
    expect(e.color).toBe(0x57f287)
    expect(e.title).toBe('🔐 Permission needed: Bash')
    expect(e.description).toBe('body\n\n**✅ Allowed** (me)')
    expect(e.footer).toBeUndefined()
    expect(cardEmbed({ title: 't', body: 'b', footer: '-# reply `yes abcde`' }, 'pending').toJSON().footer?.text).toBe('reply yes abcde')
  })
  test('a long body is cut to fit, keeping the status', () => {
    const body = '```\n' + 'x\n'.repeat(5000) + '```'
    const e = cardEmbed({ title: 't', body }, 'closed', 'STATUS').toJSON()
    expect(e.description!.length).toBeLessThanOrEqual(4096)
    expect(e.description!.endsWith('STATUS')).toBe(true)
    expect((e.description!.match(/```/g) ?? []).length % 2).toBe(0)
  })
})

