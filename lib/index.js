/**
 * dsh-sidebar-dnd — node half.
 *
 * Pure UI plugin: this entry exists only so the package is a valid Cordis row
 * that appears in the Host Loader. Every behaviour lives in the browser half,
 * which ships via `exports["./client"]` and is discovered through the
 * package.json `dsh.client` declaration.
 */

/** Cordis entry name. */
export const name = 'dsh-sidebar-dnd'

/** Host plugin body — this plugin has no host-side behaviour. */
function apply() {}

export { apply }
