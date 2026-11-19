/* Guard: public/omm-visualization.html must be the generated artifact. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const build = join(repo, 'third_party/zenviz-core/build.py')
const committed = join(repo, 'public/omm-visualization.html')

test('omm-visualization.html matches the shared core generator', (t) => {
  if (!existsSync(build)) {
    t.skip('zen viz-core submodule is not checked out (set its remote URL first)')
    return
  }
  const out = mkdtempSync(join(tmpdir(), 'zenviz-omm-'))
  try {
    const run = spawnSync(process.env.PYTHON || 'python', [
      build, '--product', 'omm', '--root', out,
    ], { encoding: 'utf8' })
    assert.equal(run.status, 0, `build.py failed: ${run.stderr}`)
    // Windows checkouts turn the generated LF file into CRLF; compare content,
    // not the working-tree line endings.
    const normalize = (p) => readFileSync(p).toString('utf8').replace(/\r\n/g, '\n')
    assert.equal(
      normalize(join(out, 'public/omm-visualization.html')),
      normalize(committed),
      'regenerate the file with build.py instead of editing it by hand',
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
