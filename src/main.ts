import { readConfig } from "./config.js"
import { THREAD_MAX_TWEETS } from "./constants.js"
import { createThreadGenerator } from "./generate.js"
import { getReleaseByTag, listReleases } from "./github.js"
import { loadState, hasPostedRelease, recordPostedRelease, saveState } from "./state.js"
import { postThread } from "./twitter.js"
import { prepareUpstreamCheckout } from "./upstream.js"
import { getWeightedLength, validateThread } from "./validate.js"

async function main() {
  const config = readConfig()
  const state = await loadState(config.stateFile)
  const pending = config.targetTag
    ? [await getReleaseByTag(config, config.targetTag)]
    : (await listReleases(config)).filter((release) => !hasPostedRelease(state, release))

  if (pending.length === 0) {
    console.log("No unposted releases found.")
    return
  }

  console.log(`Found ${pending.length} unposted release(s).`)
  const checkout = await prepareUpstreamCheckout(config)
  console.log(`Using upstream repo at ${checkout.directory}`)

  try {
    const generator = await createThreadGenerator(config, checkout.directory)

    try {
      let nextState = state

      for (const release of pending) {
        console.log(`\nProcessing ${release.tag}${release.draft ? " (draft)" : ""}...`)
        const range = await checkout.resolveRange(release)
        console.log(`Tag range: ${range.fromTag ?? "<none>"} -> ${range.toTag}`)

        const report = await generator.generateReport(range)
        console.log(JSON.stringify(report, null, 2))

        const validationErrors = validateThread(report.tweets, THREAD_MAX_TWEETS)
        if (validationErrors.length > 0) {
          throw new Error(`Generated thread for ${release.tag} is invalid`)
        }

        for (const [index, tweet] of report.tweets.entries()) {
          console.log(`tweet ${index + 1}: ${getWeightedLength(tweet)}/280`)
        }

        const tweetIds = await postThread(report.tweets, config)

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
