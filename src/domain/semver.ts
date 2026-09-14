export type SemVer = {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseSemver(value: string): SemVer | null {
  const match = SEMVER_PATTERN.exec(value.trim())
  if (!match) return null

  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

export function semverFromString(value: string): SemVer {
  const parsed = parseSemver(value)
  if (!parsed) {
    throw new Error(`Version is not semver: ${value}`)
  }
  return parsed
}

export function majorOf(value: string) {
  return semverFromString(value).major
}

function compareIdentifiers(left: string, right: string) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareSemver(left: SemVer, right: SemVer) {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length
  }

  const length = Math.min(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const comparison = compareIdentifiers(left.prerelease[index]!, right.prerelease[index]!)
    if (comparison !== 0) return comparison
  }

  return left.prerelease.length - right.prerelease.length
}

export function compareVersionStrings(left: string, right: string) {
  return compareSemver(semverFromString(left), semverFromString(right))
}
