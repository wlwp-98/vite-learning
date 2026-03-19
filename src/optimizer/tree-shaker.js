/**
 * Tree-Shaking 实现 - 移除未使用的代码
 * 
 * 核心原理：
 * 1. 标记使用的导出 (Mark Phase)
 * 2. 扫描并消除未标记的代码 (Sweep Phase)
 * 3. 考虑副作用 (Side Effects)
 * 
 * 这是一个简化的实现，展示核心概念
 */

import MagicString from 'magic-string'
import { findUnusedExports, extractExports, extractImports } from '../utils/ast-utils.js'
import { logger } from '../utils/logger.js'

export class TreeShaker {
  constructor(config = {}) {
    this.config = config
    this.usedExports = new Map() // {moduleId: Set<exportName>}
    this.sideEffects = new Set() // 有副作用的文件
    this.preserveModules = new Set(config.preserveModules || [])
  }

  /**
   * 分析代码并标记使用的导出
   */
  analyzeUsage(code, moduleId, importedBy = []) {
    const exports = extractExports(code)
    const usedSet = new Set()

    // 根据谁导入了这个模块来标记使用
    for (const importer of importedBy) {
      const importedNames = this._extractImportedNames(importer, moduleId)
      importedNames.forEach((name) => usedSet.add(name))
    }

    this.usedExports.set(moduleId, usedSet)

    return usedSet
  }

  /**
   * 从导入者代码中提取导入的名称
   */
  _extractImportedNames(importerCode, moduleId) {
    const imported = new Set()

    // 匹配 import { name1, name2 } from 'moduleId'
    const importPattern = new RegExp(
      `import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+))?\s+from\s+['"]\`?${moduleId.replace(/[.*+?^${}()|[\]\]/g, '\$&')}['"]`,
      'g'
    )

    let match
    while ((match = importPattern.exec(importerCode)) !== null) {
      if (match[1]) {
        // 命名导入
        const names = match[1].split(',').map((n) => n.trim().split(' as ')[0])
        names.forEach((name) => imported.add(name))
      } else if (match[2]) {
        // 命名空间导入 (import * as xxx)
        imported.add(match[2])
      }
    }

    return imported
  }

  /**
   * 标记模块有副作用
   */
  markWithSideEffects(moduleId) {
    this.sideEffects.add(moduleId)
  }

  /**
   * 检查模块是否有副作用
   */
  hasSideEffects(moduleId) {
    return this.sideEffects.has(moduleId) || this.preserveModules.has(moduleId)
  }

  /**
   * 执行 tree-shaking - 移除未使用的导出
   */
  shake(code, moduleId, importedBy = []) {
    // 如果模块有副作用或在保护列表中，不进行 tree-shaking
    if (this.hasSideEffects(moduleId)) {
      return code
    }

    // 分析使用情况
    this.analyzeUsage(code, moduleId, importedBy)
    const used = this.usedExports.get(moduleId) || new Set()

    // 找出未使用的导出
    const exports = extractExports(code)
    const toRemove = exports.filter((exp) => !used.has(exp.name) && exp.type === 'named')

    if (toRemove.length === 0) {
      return code
    }

    return this._removeExports(code, toRemove)
  }

  /**
   * 移除指定的导出语句
   */
  _removeExports(code, toRemove) {
    const s = new MagicString(code)
    const removeNames = new Set(toRemove.map((exp) => exp.name))

    // 匹配 export { name1, name2 } 格式
    const exportBlockPattern = /export\s*\{([^}]+)\}/g
    let match

    while ((match = exportBlockPattern.exec(code)) !== null) {
      const exportList = match[1]
      const items = exportList.split(',').map((item) => item.trim())

      const filtered = items.filter((item) => {
        const name = item.split(' as ')[0].trim()
        return !removeNames.has(name)
      })

      if (filtered.length === 0) {
        // 移除整个 export 块
        s.remove(match.index, match.index + match[0].length)
      } else if (filtered.length < items.length) {
        // 更新 export 块
        const newExportList = filtered.join(', ')
        s.overwrite(match.index, match.index + match[0].length, `export { ${newExportList} }`)
      }
    }

    // 移除 export const/let/var/function/class 声明
    for (const name of removeNames) {
      const declarePatterns = [
        new RegExp(`export\s+const\s+${name}\s*=.*?(?=;|\n|$)`, 'g'),
        new RegExp(`export\s+let\s+${name}\s*=.*?(?=;|\n|$)`, 'g'),
        new RegExp(`export\s+var\s+${name}\s*=.*?(?=;|\n|$)`, 'g'),
        new RegExp(`export\s+(?:function|class)\s+${name}\s*\{[^}]+\}`, 'gs'),
      ]

      for (const pattern of declarePatterns) {
        match = pattern.exec(code)
        if (match) {
          s.remove(match.index, match.index + match[0].length)
        }
      }
    }

    return s.toString()
  }

  /**
   * 优化导入语句 - 只导入使用的部分
   */
  optimizeImports(code, moduleId) {
    const s = new MagicString(code)
    const imports = extractImports(code)

    for (const imp of imports) {
      const used = this.usedExports.get(imp.source) || new Set()

      // 匹配这个具体的导入语句
      const importPattern = new RegExp(
        `import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+))?.*?from\s+['"]\`?${imp.source.replace(/[.*+?^${}()|[\]\]/g, '\$&')}['"]`,
        'g'
      )

      let match
      while ((match = importPattern.exec(code)) !== null) {
        if (match[1]) {
          // 命名导入 - 过滤未使用的
          const imported = match[1]
            .split(',')
            .map((item) => {
              const [name, alias] = item.trim().split(' as ')
              return { name: name.trim(), alias: alias?.trim() }
            })

          const filtered = imported.filter((item) => used.has(item.name))

          if (filtered.length > 0 && filtered.length < imported.length) {
            const newList = filtered.map((item) => (item.alias ? `${item.name} as ${item.alias}` : item.name)).join(', ')

            const importStatement = match[0]
            const newImportStatement = importStatement.replace(`{${imported.map((i) => i.alias ? `${i.name} as ${i.alias}` : i.name).join(', ')}}`, `{${newList}}`)

            s.overwrite(match.index, match.index + importStatement.length, newImportStatement)
          }
        }
      }
    }

    return s.toString()
  }

  /**
   * 生成 tree-shaking 报告
   */
  generateReport(moduleId) {
    const used = this.usedExports.get(moduleId) || new Set()
    const hasSideEffect = this.hasSideEffects(moduleId)

    return {
      moduleId,
      usedExports: Array.from(used),
      usedCount: used.size,
      hasSideEffects: hasSideEffect,
      canShake: !hasSideEffect && used.size > 0,
    }
  }

  /**
   * 批量处理多个模块
   */
  batchShake(modules) {
    // modules 应该是 {moduleId: {code, importedBy: []}}
    const results = {}

    for (const [moduleId, data] of Object.entries(modules)) {
      if (!this.hasSideEffects(moduleId)) {
        results[moduleId] = this.shake(data.code, moduleId, data.importedBy || [])
      } else {
        results[moduleId] = data.code
      }
    }

    return results
  }

  /**
   * 清除缓存
   */
  clear() {
    this.usedExports.clear()
    this.sideEffects.clear()
  }
}

export default TreeShaker