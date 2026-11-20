'use client'

import { useState, useEffect } from 'react'
import { formatEther } from 'viem'
import { useWalletClient, useChainId, useSwitchChain } from 'wagmi'
import { l1PublicClient, config } from '@/lib/config'
import { L1_BRIDGE_ABI } from '@/lib/contracts'
import type { WithdrawalData } from '@/lib/withdrawal-actions'

interface FinalizeStepProps {
  withdrawalData: WithdrawalData
  provenAt: number
  onFinalized: () => void
}

export function FinalizeStep({ withdrawalData, provenAt, onFinalized }: FinalizeStepProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canFinalize, setCanFinalize] = useState(false)
  const [timeRemaining, setTimeRemaining] = useState(0)
  const [isFinalized, setIsFinalized] = useState(false)
  
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const { data: walletClient } = useWalletClient()
  const isOnL1 = chainId === config.l1ChainId

  // Check if withdrawal can be finalized
  useEffect(() => {
    const checkFinalizability = () => {
      const now = Math.floor(Date.now() / 1000)
      const readyAt = provenAt + config.withdrawalDelaySecs
      const remaining = readyAt - now
      
      setCanFinalize(remaining <= 0)
      setTimeRemaining(Math.max(0, remaining))
    }

    checkFinalizability()
    const interval = setInterval(checkFinalizability, 1000)
    return () => clearInterval(interval)
  }, [provenAt])

  const handleFinalize = async () => {
    if (!walletClient) {
      setError('Please connect your wallet')
      return
    }

    if (!isOnL1) {
      await switchChain({ chainId: config.l1ChainId })
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Submit finalize transaction
      const tx = await walletClient.writeContract({
        address: config.l1BridgeAddress,
        abi: L1_BRIDGE_ABI,
        functionName: 'finalizeWithdrawal',
        args: [
          withdrawalData.to,
          withdrawalData.amount,
          withdrawalData.nonce
        ],
        chain: walletClient.chain,
      })

      // Wait for confirmation
      const receipt = await l1PublicClient.waitForTransactionReceipt({ hash: tx })
      
      if (receipt.status === 'success') {
        setIsFinalized(true)
        // Don't call onFinalized immediately, let user clear manually
      } else {
        throw new Error('Transaction failed')
      }
    } catch (err) {
      console.error('Finalize error:', err)
      setError(err instanceof Error ? err.message : 'Failed to finalize withdrawal')
    } finally {
      setLoading(false)
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div>
      {isFinalized ? (
        <>
          <h3 className="text-lg font-semibold mb-4 text-ok">✅ Withdrawal Complete!</h3>
          
          <div className="space-y-4">
            <div className="p-4 bg-ok-soft border border-ok-line rounded-lg">
              <p className="text-sm text-ok mb-2">
                Your withdrawal has been successfully finalized!
              </p>
              <p className="text-xs text-ok">
                The funds have been transferred to your L1 address.
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
            
            {/* <button
              onClick={() => {
                onFinalized()
                window.location.reload()
              }}
              className="w-full py-2 px-4 bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
            >
              Start New Withdrawal
            </button> */}
          </div>
        </>
      ) : (
        <>
          <h3 className="text-lg font-semibold mb-4">Step 4: Finalize Withdrawal</h3>
          
          {!isOnL1 && (
            <div className="mb-4 p-4 bg-warn-soft border border-warn-line rounded-lg">
              <p className="text-sm text-warn">
                You need to be on L1 to finalize the withdrawal. 
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
            {!canFinalize ? (
              <div className="p-4 bg-warn-soft border border-warn-line rounded-lg">
                <p className="text-sm text-warn mb-1">
                  Waiting for security delay...
                </p>
                <p className="text-2xl font-bold text-warn">
                  {formatTime(timeRemaining)}
                </p>
                <p className="text-xs text-warn mt-1">
                  This delay ensures the security of the withdrawal process.
                </p>
              </div>
            ) : (
              <div className="p-4 bg-ok-soft border border-ok-line rounded-lg">
                <p className="text-sm text-ok">
                  Your withdrawal is ready to be finalized!
                </p>
              </div>
            )}

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

            <button
              onClick={handleFinalize}
              disabled={loading || !canFinalize || !isOnL1}
              className="w-full py-2 px-4 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:bg-line disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Finalizing...' : 'Finalize Withdrawal'}
            </button>

            <div className="p-3 bg-inset rounded-lg">
              <p className="text-xs text-dim">
                <strong>Final step!</strong> This will transfer the funds to your L1 address. 
                The transaction will complete the withdrawal process.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}