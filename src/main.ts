import { readConfig } from "./config.js"
import { MODEL, THREAD_MAX_TWEETS } from "./constants.js"
import { createThreadGenerator } from "./generate.js"
import { getReleaseByTag, listReleases } from "./github.js"
import {
  getLatestPostedRelease,
  getSavedRelease,
  hasPostedRelease,
  isFinishedPostedRelease,
  loadState,
  recordErroredRelease,
  recordPostedRelease,
  recordPostingProgress,
  saveState,
} from "./state.js"
import { postThread } from "./twitter.js"
import { prepareUpstreamCheckout } from "./upstream.js"
import { getWeightedLength, validateThread } from "./validate.js"

function releaseTimestamp(release: { publishedAt: string | null; createdAt: string }) {
  return release.publishedAt ?? release.createdAt
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const config = readConfig()
  const state = await loadState(config.stateFile)
  const latestPostedRelease = getLatestPostedRelease(state)
  const resolvedPending = config.targetTag
    ? [await getReleaseByTag(config, config.targetTag)]
    : (await listReleases(config)).filter((release) => {
        if (hasPostedRelease(state, release)) return false
        if (!latestPostedRelease) return true

        const latestTimestamp = latestPostedRelease.publishedAt ?? latestPostedRelease.postedAt
        const currentTimestamp = releaseTimestamp(release)

        if (currentTimestamp > latestTimestamp) return true
        if (currentTimestamp === latestTimestamp && release.id > latestPostedRelease.releaseId) return true

        return false
      })

  const targetedRelease = config.targetTag ? resolvedPending[0] : undefined
  if (targetedRelease && !config.dryRun && hasPostedRelease(state, targetedRelease)) {
    throw new Error(`${targetedRelease.tag} was already processed. Use --dry-run to preview it again.`)
  }

  if (resolvedPending.length === 0) {
    console.log("No unposted releases found.")
    return
  }

  console.log(`Found ${resolvedPending.length} unposted release(s).`)
  if (!config.targetTag && latestPostedRelease) {
    console.log(`Cron baseline: ${latestPostedRelease.tag}`)
  }
  const checkout = await prepareUpstreamCheckout(config)
  console.log(`Using upstream repo at ${checkout.directory}`)

  try {
    const generator = await createThreadGenerator(config, checkout.directory)

    try {
      let nextState = state

      for (const release of resolvedPending) {
        console.log(`\nProcessing ${release.tag}${release.draft ? " (draft)" : ""}...`)
        const range = await checkout.resolveRange(release)
        console.log(`Tag range: ${range.fromTag ?? "<none>"} -> ${range.toLabel}`)

        const savedRelease = getSavedRelease(nextState, release)
        const report =
          !config.dryRun && savedRelease && !isFinishedPostedRelease(savedRelease) && savedRelease.tweetIds.length > 0
            ? {
                kind: "release" as const,
                tag: release.tag,
                releaseUrl: release.url,
                compareUrl: range.compareUrl,
                fromTag: range.fromTag,
                toTag: range.toTag,
                toLabel: range.toLabel,
                draft: release.draft,
                model: MODEL,
                tweets: savedRelease.tweets,
              }
            : await generator.generateReport(range)
        console.log(JSON.stringify(report, null, 2))

        const validationErrors = validateThread(report.tweets, THREAD_MAX_TWEETS)
        if (validationErrors.length > 0) {
          throw new Error(`Generated thread for ${release.tag} is invalid`)
        }

        for (const [index, tweet] of report.tweets.entries()) {
          console.log(`tweet ${index + 1}: ${getWeightedLength(tweet)}/280`)
        }

        const existingTweetIds = !config.dryRun && savedRelease && !isFinishedPostedRelease(savedRelease) ? savedRelease.tweetIds : []
        let latestTweetIds = existingTweetIds

        if (!config.dryRun) {
          nextState = recordPostingProgress(nextState, {
            release,
            tweets: report.tweets,
            tweetIds: existingTweetIds,
          })
          await saveState(config.stateFile, nextState)
        }

        let tweetIds: string[]
        try {
          tweetIds = await postThread(report.tweets, config, {
            existingTweetIds,
            onProgress: async (partialTweetIds) => {
              latestTweetIds = partialTweetIds

              if (config.dryRun) return

              nextState = recordPostingProgress(nextState, {
                release,
                tweets: report.tweets,
                tweetIds: partialTweetIds,
              })
              await saveState(config.stateFile, nextState)
            },
          })
        } catch (error) {
          if (!config.dryRun) {
            const errorMessage = toErrorMessage(error)
            console.error(`Marking ${release.tag} as errored after ${latestTweetIds.length}/${report.tweets.length} post(s).`)
            nextState = recordErroredRelease(nextState, release, report.tweets, latestTweetIds, errorMessage)
            await saveState(config.stateFile, nextState)
          }

          throw error
        }

        if (!config.dryRun) {
          nextState = recordPostedRelease(nextState, release, report.tweets, tweetIds)
          await saveState(config.stateFile, nextState)
        }
      }
    } finally {
      await generator.close()
    }
  } finally {
    await checkout.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
