'use client'

import { useState } from 'react'
import { formatEther } from 'viem'
import { useWalletClient, useChainId, useSwitchChain } from 'wagmi'
import { l1PublicClient, l2PublicClient, config } from '@/lib/config'
import { ROLLUP_ABI } from '@/lib/contracts'
import type { WithdrawalData } from '@/lib/withdrawal-actions'
import { buildProveWithdrawalSuccinct, proveWithdrawalSuccinct } from '@/lib/actions'
import { useLatestWithdrawal } from '@/hooks/useLatestWithdrawal'

interface ProveStepProps {
  withdrawalData: WithdrawalData
  proposalId: number
  onProven: (provenAt: number) => void
}

export function ProveStep({ withdrawalData, proposalId, onProven }: ProveStepProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null)
  const [txStatus, setTxStatus] = useState<'pending' | 'confirmed' | null>(null)
  
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const { data: walletClient } = useWalletClient()
  const isOnL1 = chainId === config.l1ChainId
  
  // Get the withdrawal block number
  const { withdrawal } = useLatestWithdrawal()

  const handleProve = async () => {
    if (!walletClient) {
      setError('Please connect your wallet')
      return
    }

    if (!isOnL1) {
      try {
        await switchChain({ chainId: config.l1ChainId })
      } catch (err) {
        setError('Chain switch cancelled or failed')
      }
      return
    }

    setLoading(true)
    setError(null)

    try {
      if (!withdrawal) {
        throw new Error('Could not find withdrawal block number')
      }

      // Get proposal data
      const proposal = await l1PublicClient.readContract({
        address: config.rollupAddress,
        abi: ROLLUP_ABI,
        functionName: 'getProposal',
        args: [BigInt(proposalId)]
      })

      console.log('Building withdrawal proof...')
      console.log('Proposal:', proposal)
      console.log('Withdrawal block:', withdrawal.blockNumber)

      // Build the proof parameters using the same logic as the script
      const proofParams = await buildProveWithdrawalSuccinct(l1PublicClient, {
        to: withdrawalData.to,
        amount: withdrawalData.amount,
        nonce: withdrawalData.nonce,
        proposalId: BigInt(proposalId),
        outputRoot: proposal.rootClaim,
        l2BlockNumber: BigInt(proposal.l2BlockNumber), // Use the proposal's block number
        bridgeAddress: config.l1BridgeAddress,
        l2Client: l2PublicClient
      })

      console.log('Proof params built, submitting transaction...')
      
      // Ensure wallet is fully initialized
      if (!walletClient.chain || !walletClient.account) {
        throw new Error('Wallet not fully initialized - please reconnect')
      }

      // Submit prove transaction using the built parameters
      const tx = await proveWithdrawalSuccinct(walletClient, proofParams)
      
      setPendingTxHash(tx)
      setTxStatus('pending')

      // Wait for confirmation
      const receipt = await l1PublicClient.waitForTransactionReceipt({ hash: tx })
      
      if (receipt.status === 'success') {
        setTxStatus('confirmed')
        const timestamp = Math.floor(Date.now() / 1000)
        
        // Clear the status after a short delay
        setTimeout(() => {
          setPendingTxHash(null)
          setTxStatus(null)
        }, 3000)
        
        onProven(timestamp)
      } else {
        throw new Error('Transaction failed')
      }
    } catch (err) {
      console.error('Prove error:', err)
      setError(err instanceof Error ? err.message : 'Failed to prove withdrawal')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Step 3: Prove Withdrawal</h3>
      
      {!isOnL1 && (
        <div className="mb-4 p-4 bg-warn-soft border border-warn-line rounded-lg">
          <p className="text-sm text-warn">
            You need to be on L1 to prove the withdrawal. 
            <button
              onClick={() => switchChain({ chainId: config.l1ChainId })}
              className="ml-2 text-warn underline hover:text-ink"
            >
              Switch to L1
            </button>
          </p>
        </div>
      )}

      <div className="space-y-4">
        <div className="p-4 bg-ok-soft border border-ok-line rounded-lg">
          <p className="text-sm text-ok mb-1">
            Your withdrawal is ready to be proven!
          </p>
          <p className="text-xs text-ok">
            Proposal #{proposalId} is canonical and contains your withdrawal.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-dim">Amount:</span>
            <span>{formatEther(withdrawalData.amount)} ETH</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-dim">Recipient:</span>
            <span className="font-mono text-xs">{withdrawalData.to}</span>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-err-soft border border-err-line rounded-lg">
            <p className="text-sm text-err">{error}</p>
          </div>
        )}

        {pendingTxHash && (
          <div className={`p-3 border rounded-lg ${
            txStatus === 'confirmed' 
              ? 'bg-ok-soft border-ok-line' 
              : 'bg-accent-soft border-accent-line'
          }`}>
            <p className={`text-sm ${
              txStatus === 'confirmed' ? 'text-ok' : 'text-dim'
            }`}>
              {txStatus === 'pending' && '⏳ Proof transaction pending...'}
              {txStatus === 'confirmed' && '✅ Proof submitted successfully!'}
            </p>
            <p className="text-xs text-dim mt-1">
              Hash: {pendingTxHash.slice(0, 10)}...{pendingTxHash.slice(-8)}
            </p>
            {txStatus === 'pending' && (
              <p className="text-xs text-link mt-1">Waiting for confirmation...</p>
            )}
          </div>
        )}

        <button
          onClick={handleProve}
          disabled={loading || !isOnL1}
          className="w-full py-2 px-4 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:bg-line disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (txStatus === 'pending' ? 'Confirming...' : 'Building Proof...') : 'Prove Withdrawal'}
        </button>

        <div className="p-3 bg-inset rounded-lg">
          <p className="text-xs text-dim">
            <strong>Note:</strong> This will submit a proof that your withdrawal exists in the 
            L2 state. After proving, you'll need to wait for a short delay before finalizing.
          </p>
        </div>
      </div>
    </div>
  )
}