import { readConfig } from "./config.js"
import { MODEL, POST_MAX_LENGTH, THREAD_MAX_TWEETS } from "./constants.js"
import { createPostGenerator } from "./generate.js"
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
import { postMessage, postThread } from "./twitter.js"
import { prepareUpstreamCheckout } from "./upstream.js"
import { getCharacterLength, getWeightedLength, validatePost, validateThread } from "./validate.js"

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
    const generator = await createPostGenerator(config, checkout.directory)

    try {
      let nextState = state

      for (const release of resolvedPending) {
        console.log(`\nProcessing ${release.tag}${release.draft ? " (draft)" : ""}...`)
        const range = await checkout.resolveRange(release)
        console.log(`Tag range: ${range.fromTag ?? "<none>"} -> ${range.toLabel}`)

        const savedRelease = getSavedRelease(nextState, release)
        const savedLegacyThread = !config.dryRun && savedRelease && !isFinishedPostedRelease(savedRelease) && savedRelease.tweets.length > 1
          ? savedRelease
          : null
        const savedPost = !config.dryRun && savedRelease && !isFinishedPostedRelease(savedRelease) && savedRelease.tweets.length === 1
          ? savedRelease
          : null

        if (savedLegacyThread) {
          console.log(`Resuming saved legacy thread with ${savedLegacyThread.tweets.length} tweet(s).`)

          const validationErrors = validateThread(savedLegacyThread.tweets, THREAD_MAX_TWEETS)
          if (validationErrors.length > 0) {
            throw new Error(`Saved legacy thread for ${release.tag} is invalid`)
          }

          for (const [index, tweet] of savedLegacyThread.tweets.entries()) {
            console.log(`legacy tweet ${index + 1}: ${getWeightedLength(tweet)}/280`)
          }

          let latestTweetIds = savedLegacyThread.tweetIds

          if (!config.dryRun) {
            nextState = recordPostingProgress(nextState, {
              release,
              tweets: savedLegacyThread.tweets,
              tweetIds: savedLegacyThread.tweetIds,
            })
            await saveState(config.stateFile, nextState)
          }

          let tweetIds: string[]
          try {
            tweetIds = await postThread(savedLegacyThread.tweets, config, {
              existingTweetIds: savedLegacyThread.tweetIds,
              onProgress: async (partialTweetIds) => {
                latestTweetIds = partialTweetIds

                if (config.dryRun) return

                nextState = recordPostingProgress(nextState, {
                  release,
                  tweets: savedLegacyThread.tweets,
                  tweetIds: partialTweetIds,
                })
                await saveState(config.stateFile, nextState)
              },
            })
          } catch (error) {
            if (!config.dryRun) {
              const errorMessage = toErrorMessage(error)
              console.error(`Marking ${release.tag} as errored after ${latestTweetIds.length}/${savedLegacyThread.tweets.length} post(s).`)
              nextState = recordErroredRelease(nextState, release, savedLegacyThread.tweets, latestTweetIds, errorMessage)
              await saveState(config.stateFile, nextState)
            }

            throw error
          }

          if (!config.dryRun) {
            nextState = recordPostedRelease(nextState, release, savedLegacyThread.tweets, tweetIds)
            await saveState(config.stateFile, nextState)
          }

          continue
        }

        const savedPostText = savedPost?.tweets[0]
        if (savedPost && !savedPostText) {
          throw new Error(`Saved post for ${release.tag} is empty`)
        }

        const report = savedPostText
          ? {
              kind: range.kind,
              tag: release.tag,
              releaseUrl: release.url,
              compareUrl: range.compareUrl,
              fromTag: range.fromTag,
              toTag: range.toTag,
              toLabel: range.toLabel,
              draft: release.draft,
              model: MODEL,
              post: savedPostText,
            }
          : await generator.generateReport(range)
        console.log(JSON.stringify(report, null, 2))

        const validationErrors = validatePost(report.post, POST_MAX_LENGTH)
        if (validationErrors.length > 0) {
          throw new Error(`Generated post for ${release.tag} is invalid: ${validationErrors.join("; ")}`)
        }

        console.log(`post: ${getCharacterLength(report.post)}/${POST_MAX_LENGTH}`)

        const existingTweetIds = savedPost ? savedPost.tweetIds.slice(0, 1) : []
        let latestTweetIds = existingTweetIds

        if (!config.dryRun) {
          nextState = recordPostingProgress(nextState, {
            release,
            tweets: [report.post],
            tweetIds: existingTweetIds,
          })
          await saveState(config.stateFile, nextState)
        }

        let tweetIds: string[]
        try {
          tweetIds = await postMessage(report.post, config, {
            existingTweetIds,
            onProgress: async (partialTweetIds) => {
              latestTweetIds = partialTweetIds

              if (config.dryRun) return

              nextState = recordPostingProgress(nextState, {
                release,
                tweets: [report.post],
                tweetIds: partialTweetIds,
              })
              await saveState(config.stateFile, nextState)
            },
          })
        } catch (error) {
          if (!config.dryRun) {
            const errorMessage = toErrorMessage(error)
            console.error(`Marking ${release.tag} as errored after ${latestTweetIds.length}/1 post(s).`)
            nextState = recordErroredRelease(nextState, release, [report.post], latestTweetIds, errorMessage)
            await saveState(config.stateFile, nextState)
          }

          throw error
        }

        if (!config.dryRun) {
          nextState = recordPostedRelease(nextState, release, [report.post], tweetIds)
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
