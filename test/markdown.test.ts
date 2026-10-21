/**
 * Markdown Discord can't render, rewritten before it is posted.
 * Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test'
import { discordify } from '../src/markdown'

describe('discordify', () => {
  test('two-column table becomes a list', () => {
    const md = ['Intro', '', '| Key | Meaning |', '|---|---|', '| `a` | first |', '| **b** | second |', '', 'After'].join('\n')
    expect(discordify(md)).toBe(['Intro', '', '- **`a`** — first', '- **b** — second', '', 'After'].join('\n'))
  })
  test('wider table: first cell, then header: value', () => {
    const md = ['| Name | When | How |', '| :-- | --- | --: |', '| one | now | fast |', '| two |  | slow |'].join('\n')
    expect(discordify(md)).toBe(['- **one**', '  - When: now', '  - How: fast', '- **two**', '  - How: slow'].join('\n'))
  })
  test('Chinese headers get a full-width colon', () => {
    expect(discordify(['| 机制 | 删哪些 | 何时 |', '|---|---|---|', '| 上限 | 最早的 | 490 个 |'].join('\n'))).toBe(
      ['- **上限**', '  - 删哪些：最早的', '  - 何时：490 个'].join('\n'),
    )
  })
  test('a table without a first header keeps its row labels', () => {
    const md = ['| | Value |', '|---|---|', '| x | 1 |'].join('\n')
    expect(discordify(md)).toBe('- **x** — 1')
  })
  test('pipes escaped inside a cell stay', () => {
    expect(discordify(['| a | b |', '|---|---|', '| x \\| y | z |'].join('\n'))).toBe('- **x | y** — z')
  })
  test('code blocks are left alone', () => {
    const md = ['```', '| a | b |', '|---|---|', '#### not a heading', '---', '```'].join('\n')
    expect(discordify(md)).toBe(md)
  })
  test('deep headings and rules', () => {
    expect(discordify(['#### Detail', 'text', '---', '## Kept'].join('\n'))).toBe(['**Detail**', 'text', '## Kept'].join('\n'))
  })
  test('a pipe line that is not a table is kept', () => {
    expect(discordify('| just a line |')).toBe('| just a line |')
  })
})
