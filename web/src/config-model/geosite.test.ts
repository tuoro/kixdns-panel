import { describe, expect, it } from 'vitest'
import type { GeositeCategories } from '../api/types'
import { bangNote, geositeIssue, geositeWarning, mergeCatalog, refineOptions, searchGeosite, splitTag } from './geosite'

const google = { name: 'google', domains: 1077, attributes: [{ key: '!cn', domains: 7 }, { key: 'ads', domains: 54 }, { key: 'cn', domains: 126 }] }
const response: GeositeCategories = {
  files: [
    { path: '/geo/a.dat', sha256: 'a', error: null },
    { path: '/geo/b.dat', sha256: 'b', error: null },
    { path: '/etc/kixdns/mine.dat', sha256: null, error: '面板没有权限读这个文件' },
  ],
  builtin: { path: '/usr/share/kixdns-panel/geo/geosite.dat', sha256: 'a', error: null },
  catalogs: {
    a: [{ name: 'cn', domains: 110622, attributes: [] }, google, { name: 'apple', domains: 1792, attributes: [{ key: 'cn', domains: 296 }] }, { name: 'apple-cn', domains: 165, attributes: [] }, { name: 'category-games', domains: 1127, attributes: [] }],
    b: [{ name: 'cn', domains: 5, attributes: [] }],
  },
}

describe('GeoSite catalog', () => {
  it('splits an attribute the way the kernel does', () => {
    expect(splitTag('google@cn')).toEqual({ base: 'google', attr: 'cn' })
    expect(splitTag('google@!cn')).toEqual({ base: 'google', attr: '!cn' })
    expect(splitTag('google@')).toEqual({ base: 'google@', attr: null })
    expect(splitTag('@cn')).toEqual({ base: '@cn', attr: null })
  })

  it('merges files in draft order, the later file winning a shared category', () => {
    const catalog = mergeCatalog(response, ['/geo/a.dat', '/geo/b.dat'], 'ok')
    expect(catalog.state).toBe('ready')
    expect(catalog.categories.get('cn')?.domains).toBe(5)
    expect(mergeCatalog(response, ['/geo/b.dat', '/geo/a.dat'], 'ok').categories.get('cn')?.domains).toBe(110622)
  })

  it('stays partial when a file did not read or is not saved, and says why', () => {
    const catalog = mergeCatalog(response, ['/geo/a.dat', '/etc/kixdns/mine.dat', '/new.dat'], 'ok')
    expect(catalog.state).toBe('partial')
    expect(catalog.gaps).toEqual([
      { path: '/etc/kixdns/mine.dat', reason: '面板没有权限读这个文件' },
      { path: '/new.dat', reason: '还没保存，保存后才能读出里面的分类' },
    ])
    expect(geositeIssue('nope', catalog)).toBeNull()
  })

  it('lists the package categories when the draft has no GeoSite file, and every value then misses', () => {
    const catalog = mergeCatalog(response, [], 'ok')
    expect(catalog.state).toBe('builtin')
    expect(catalog.categories.has('google')).toBe(true)
    expect(geositeIssue('cn', catalog)).toEqual({ kind: 'no-data' })
    expect(mergeCatalog({ ...response, builtin: null }, ['  '], 'ok').state).toBe('none')
    expect(mergeCatalog(null, [], 'loading').state).toBe('loading')
    expect(mergeCatalog(null, [], 'failed').state).toBe('failed')
  })

  it('points out a missing category or attribute only when the data is complete', () => {
    const catalog = mergeCatalog(response, ['/geo/a.dat'], 'ok')
    expect(geositeIssue('GOOGLE@CN', catalog)).toBeNull()
    expect(geositeIssue('google@!cn', catalog)).toBeNull()
    expect(geositeIssue('googel', catalog)).toEqual({ kind: 'category', base: 'googel' })
    expect(geositeIssue('google@telemetry', catalog)).toEqual({ kind: 'attribute', base: 'google', attr: 'telemetry' })
    // geosite: 前缀是另一种错，由格式检查说 / A geosite: prefix is a different mistake, reported by the format check
    expect(geositeIssue('geosite:cn', catalog)).toBeNull()
    expect(geositeWarning(['cn', 'googel'], false, catalog)).toBe('当前 GeoSite 数据里没有 googel，这个值不会命中')
    expect(geositeWarning(['google@telemetry'], true, catalog)).toBe('google 里没有标 telemetry 的域名，「不属于」对所有域名都成立')
    expect(geositeWarning(['cn'], false, mergeCatalog(response, [], 'ok'))).toBe('还没有 GeoSite 数据，这个条件不会命中。到「基础设置 › Geo 数据」导入或填写')
  })

  it('explains @! as the literal attribute and how to write without', () => {
    expect(bangNote(['cn'])).toBeNull()
    expect(bangNote(['cn', 'google@!cn'])).toBe('google@!cn 指标了 !cn 的域名（和 V2Ray 一样）。要「google 里不带 cn 的」，再加一个条件：不属于 google@cn')
  })

  it('offers 全部 first and then attributes by size', () => {
    expect(refineOptions(google).map((o) => [o.value, o.note, o.domains])).toEqual([
      ['google', '全部', 1077],
      ['google@cn', '在中国大陆有接入点', 126],
      ['google@ads', '广告', 54],
      ['google@!cn', '被排除出国内列表', 7],
    ])
  })

  it('searches exact, prefix, then substring and notes, larger first, without what is chosen', () => {
    const catalog = mergeCatalog(response, ['/geo/a.dat'], 'ok')
    expect(searchGeosite(catalog, '').map((o) => o.value)).toEqual(['cn', 'apple', 'google', 'category-games'])
    expect(searchGeosite(catalog, 'apple').map((o) => o.value)).toEqual(['apple', 'apple-cn'])
    expect(searchGeosite(catalog, 'geosite:Apple', ['apple']).map((o) => o.value)).toEqual(['apple-cn'])
    expect(searchGeosite(catalog, 'g').map((o) => o.value)).toEqual(['google', 'category-games'])
    expect(searchGeosite(catalog, '谷歌').map((o) => o.value)).toEqual(['google'])
    expect(searchGeosite(catalog, 'google@').map((o) => o.value)).toEqual(['google@cn', 'google@ads', 'google@!cn'])
    expect(searchGeosite(catalog, 'google@!').map((o) => o.value)).toEqual(['google@!cn'])
    expect(searchGeosite(catalog, 'nope@cn')).toEqual([])
    expect(searchGeosite(catalog, 'google').find((o) => o.value === 'google')?.refinable).toBe(true)
  })
})
