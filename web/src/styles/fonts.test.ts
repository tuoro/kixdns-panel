import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import viteConfig from '../../vite.config'

// 字体随面板打包，这里守住三件线上才会暴露的事：文件真的在、不会被内联成 CSP 挡掉的 data:、
// 中文不会触发拉丁字体下载。浏览器里的加载和生效由 e2e/fonts.spec.ts 验证。
// The fonts ship with the panel. These tests guard three things that only show up in
// production: the files exist, they are never inlined as data: (which the CSP blocks),
// and Chinese text never triggers a Latin font download. e2e/fonts.spec.ts checks
// loading and use in the browser.

const css = readFileSync(fileURLToPath(new URL('./fonts.css', import.meta.url)), 'utf8')
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
  family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
  weight: /font-weight:\s*(\d+)/.exec(body)?.[1],
  src: /src:\s*url\("([^"]+)"\)\s*format\("woff2"\)/.exec(body)?.[1],
  range: /unicode-range:\s*([^;]+);/.exec(body)?.[1] ?? '',
}))

/** unicode-range 里的每一段是否覆盖某个码位。 */
function covers(range: string, codePoint: number): boolean {
  return range.split(',').some((part) => {
    const [from, to = from] = part.trim().replace(/^U\+/i, '').split('-')
    return parseInt(from, 16) <= codePoint && codePoint <= parseInt(to, 16)
  })
}

describe('打包字体', () => {
  it('每个字重都指向一份存在的 woff2，只收用到的字重', () => {
    expect(faces.map((face) => `${face.family} ${face.weight}`)).toEqual([
      'Archivo 400', 'Archivo 500', 'Archivo 600', 'Archivo 700',
      'IBM Plex Mono 400', 'IBM Plex Mono 500', 'IBM Plex Mono 600',
    ])
    for (const face of faces) {
      expect(face.src).toMatch(/^@fontsource\/[a-z-]+\/files\/[a-z-]+-latin-\d00-normal\.woff2$/)
      expect(existsSync(fileURLToPath(new URL(`../../node_modules/${face.src}`, import.meta.url)))).toBe(true)
    }
  })

  it('构建时字体永远输出成文件，不内联成 data:', () => {
    const limit = viteConfig.build?.assetsInlineLimit
    expect(typeof limit).toBe('function')
    const decide = limit as (filePath: string, content: Buffer) => boolean | undefined
    for (const file of ['a.woff2', 'a.woff', 'a.ttf', 'a.otf']) expect(decide(file, Buffer.alloc(16))).toBe(false)
    // 其余资源仍按 Vite 默认的 4 KB 规则处理。
    expect(decide('icon.svg', Buffer.alloc(16))).toBeUndefined()
  })

  it('中文和全角标点不落进拉丁字体；Archivo 把弯引号留给中文字体', () => {
    for (const face of faces) {
      for (const char of ['中', '。', '，', '「', '·']) {
        const inLatin = covers(face.range, char.codePointAt(0)!)
        // 间隔号 U+00B7 属于拉丁补充，本来就该由拉丁字体画成窄点；其余都必须交给中文字体。
        expect(inLatin).toBe(char === '·')
      }
      const quotes = ['‘', '’', '“', '”'].map((char) => covers(face.range, char.codePointAt(0)!))
      expect(quotes.every((inLatin) => inLatin === (face.family === 'IBM Plex Mono'))).toBe(true)
    }
  })
})
