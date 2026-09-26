import type { LoaderContext } from '@rspack/core'
import { relative, sep } from 'node:path'
import { isTaggable, tagSource } from './source-tags.js'

export interface SourceTagsLoaderOptions {
  root: string
  packageRoot: string
}

/** Rspack pre-loader that runs `tagSource` ahead of Beast's own `.btsx` loader. */
export default function sourceTagsLoader(this: LoaderContext<SourceTagsLoaderOptions>, source: string): string {
  const { root, packageRoot } = this.getOptions()
  const file = this.resourcePath
  if (!isTaggable(file, packageRoot)) return source
  return tagSource(source, file, relative(root, file).split(sep).join('/'))
}
