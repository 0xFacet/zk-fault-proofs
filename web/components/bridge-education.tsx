'use client'

import { useState, useEffect } from 'react'
import { config, l1PublicClient, TOKEN_SYMBOL } from '@/lib/config'
import { ROLLUP_ABI } from '@/lib/contracts'

interface RollupParams {
  aggVkey: string
  rangeVkeyCommitment: string
  rollupConfigHash: string
}

export function BridgeEducation() {
  const [rollupParams, setRollupParams] = useState<RollupParams | null>(null)
  const [showParams, setShowParams] = useState(false)

  // Fetch immutable rollup parameters
  useEffect(() => {
    async function fetchParams() {
      try {
        const [aggVkey, rangeVkeyCommitment, rollupConfigHash] = await Promise.all([
          l1PublicClient.readContract({
            address: config.rollupAddress,
            abi: ROLLUP_ABI as any,
            functionName: 'AGG_VKEY',
            args: [],
          }),
          l1PublicClient.readContract({
            address: config.rollupAddress,
            abi: ROLLUP_ABI as any,
            functionName: 'RANGE_VKEY_COMMITMENT',
            args: [],
          }),
          l1PublicClient.readContract({
            address: config.rollupAddress,
            abi: ROLLUP_ABI as any,
            functionName: 'ROLLUP_CONFIG_HASH',
            args: [],
          }),
        ])

        setRollupParams({
          aggVkey: aggVkey as string,
          rangeVkeyCommitment: rangeVkeyCommitment as string,
          rollupConfigHash: rollupConfigHash as string,
        })
      } catch (err) {
        console.error('Failed to fetch rollup parameters:', err)
      }
    }
    fetchParams()
  }, [])

  return (
    <section className="mt-20 border-t border-line pt-10">
      <h2 className="text-xl font-semibold text-ink mb-8">How it works</h2>

      <dl className="grid sm:grid-cols-[8rem_1fr] gap-x-8 gap-y-2 sm:gap-y-7 text-sm leading-relaxed">
        <dt className="font-medium text-ink pt-4 sm:pt-0">Deposits</dt>
        <dd className="text-dim">
          <p>
            Your ETH is locked in the bridge contract on Ethereum, and the same amount of {TOKEN_SYMBOL} is
            minted to you on Facet as soon as your Ethereum transaction is included.
          </p>
        </dd>

        <dt className="font-medium text-ink pt-4 sm:pt-0">Withdrawals</dt>
        <dd className="text-dim">
          <p>
            Burn {TOKEN_SYMBOL} on Facet. Once a Facet state root that includes your withdrawal has been posted to
            the Rollup contract on Ethereum and has passed its 7-day challenge period, prove the withdrawal against it
            and receive your ETH. This app builds the proof in your browser.
          </p>
        </dd>

        <dt className="font-medium text-ink pt-4 sm:pt-0">No admin</dt>
        <dd className="text-dim">
          <p>
            The bridge has no owner. Nobody can pause or upgrade it, blacklist state roots, or move its funds.
            That also means a bug in this deployment can&apos;t be fixed and lost funds can&apos;t be recovered.
          </p>
        </dd>

        <dt className="font-medium text-ink pt-4 sm:pt-0">Fixed rules</dt>
        <dd className="text-dim">
          <p>
            The bridge is bound to one Rollup contract, whose immutable parameters define one set of Facet state
            transition rules. If Facet&apos;s rules change, the bridge keeps the original rules; to follow new rules,
            withdraw and use a bridge that supports them.
          </p>
          <button
            onClick={() => setShowParams(!showParams)}
            className="mt-2 text-xs text-link hover:text-ink underline"
          >
            {showParams ? 'Hide' : 'Show'} the Rollup&apos;s parameters
          </button>
          {showParams && rollupParams && (
            <div className="mt-3 p-3 bg-inset border border-line rounded-lg space-y-2">
              {([['AGG_VKEY', rollupParams.aggVkey], ['RANGE_VKEY_COMMITMENT', rollupParams.rangeVkeyCommitment],
                 ['ROLLUP_CONFIG_HASH', rollupParams.rollupConfigHash]] as const).map(([name, value]) => (
                <div key={name}>
                  <div className="text-xs font-medium text-dim">{name}</div>
                  <code className="text-xs text-ink font-mono break-all">{value}</code>
                </div>
              ))}
            </div>
          )}
        </dd>

        <dt className="font-medium text-ink pt-4 sm:pt-0">What you rely on</dt>
        <dd className="text-dim">
          <ul className="list-disc ml-4 space-y-1">
            <li>
              The bridge and Rollup contracts, the ZK program and the SP1 zkVM being correct. Bugs in the program or
              zkVM can be fixed elsewhere, but not here: these contracts and the verifier they use can&apos;t change
            </li>
            <li>Someone challenging any invalid state root within its 7-day challenge period</li>
            <li>
              State roots being posted: the Rollup&apos;s whitelisted proposers post them regularly; anyone else can
              after 14 days, or at any time with a ZK proof
            </li>
            <li>The Rollup&apos;s owner only chooses the whitelisted proposers; it cannot change the rules or move funds</li>
          </ul>
        </dd>
      </dl>
    </section>
  )
}
