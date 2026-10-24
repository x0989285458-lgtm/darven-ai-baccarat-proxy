/** Public, non-secret OCI build identity; absent/invalid input is never guessed. */
export function readReleaseIdentity(env = process.env) {
  const commit = env.GIT_SHA
  const release = env.RELEASE_VERSION
  if (typeof commit !== 'string' || commit.length !== 40 || !/^[a-f0-9]{40}$/.test(commit)
    || typeof release !== 'string' || release !== release.trim()
    || !/^v105-six-raw\.[0-9]{8}\.[1-9][0-9]*$/.test(release)) return null
  return { commit, release }
}
