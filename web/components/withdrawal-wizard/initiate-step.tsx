'use client'

import { useState, useEffect } from 'react'
import { isAddress, type Hash, formatEther, parseEther, type TransactionReceipt } from 'viem'
import { useChainId, useSwitchChain, useAccount, useWalletClient } from 'wagmi'
import { getWithdrawalDataFromTx, type WithdrawalData } from '@/lib/withdrawal-actions'
import { config, l2PublicClient, l1PublicClient, TOKEN_SYMBOL, getL1Chain } from '@/lib/config'
import { writeFacetContract } from '@0xfacet/sdk/viem'
import { useCrossDomainMessage } from '@/hooks/useCrossDomainMessage'

interface InitiateStepProps {
  onNext: (txHash: string, withdrawalData: WithdrawalData) => void
}

export function InitiateStep({ onNext }: InitiateStepProps) {
  const [mode, setMode] = useState<'existing' | 'new'>('new')
  const [txHash, setTxHash] = useState('')
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null)
  const [txStatus, setTxStatus] = useState<'pending' | 'confirmed' | null>(null)
  
  // State for cross-domain message polling
  const [l1Receipt, setL1Receipt] = useState<TransactionReceipt | null>(null)
  const [withdrawalAmount, setWithdrawalAmount] = useState<bigint>(0n)
  
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const isOnL2 = chainId === config.l2ChainId
  const isOnL1 = chainId === config.l1ChainId
  
  // Only use cross-domain message hook when we have all required data
  const shouldPoll = !!l1Receipt && !!address && !!pendingTxHash && withdrawalAmount > 0n
  
  const { 
    withdrawalData, 
    isPolling, 
    error: pollError, 
    scanProgress 
  } = useCrossDomainMessage({
    expectedAmount: withdrawalAmount,
    userAddress: address!,  // Safe because shouldPoll checks !!address
    enabled: shouldPoll
  })
  
  // Handle successful withdrawal data
  useEffect(() => {
    if (withdrawalData && pendingTxHash) {
      // Clear the transaction status after a delay
      setTimeout(() => {
        setPendingTxHash(null)
        setTxStatus(null)
        setAmount('')
        setL1Receipt(null)
        setWithdrawalAmount(0n)
      }, 3000)
      
      onNext(pendingTxHash, withdrawalData)
    }
  }, [withdrawalData, pendingTxHash, onNext])
  
  // Handle polling errors
  useEffect(() => {
    if (pollError) {
      setError(pollError.message)
      setLoading(false)
    }
  }, [pollError])
  
  // Get L2 ERC20 balance
  const [l2Balance, setL2Balance] = useState<bigint>(0n)
  
  const ERC20_ABI = [
    {
      inputs: [{ name: 'owner', type: 'address' }],
      name: 'balanceOf',
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ] as const
  
  useEffect(() => {
    async function fetchL2Balance() {
      if (!address) return
      
      try {
        const balance = await l2PublicClient.readContract({
          address: config.l2BridgeAddress,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address]
        })
        setL2Balance(balance)
      } catch (err) {
        console.error('Failed to fetch L2 balance:', err)
      }
    }
    
    fetchL2Balance()
  }, [address])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (mode === 'existing') {
        // Validate tx hash format
        if (!txHash.startsWith('0x') || txHash.length !== 66) {
          throw new Error('Invalid transaction hash format')
        }

        // Get withdrawal data from tx
        const withdrawalData = await getWithdrawalDataFromTx(txHash as Hash)
        
        // Validate withdrawal data
        if (!isAddress(withdrawalData.to)) {
          throw new Error('Invalid recipient address')
        }
        
        if (withdrawalData.amount === 0n) {
          throw new Error('Withdrawal amount is zero')
        }

        onNext(txHash, withdrawalData)
      } else {
        // Initiate new withdrawal
        if (!walletClient || !address) {
          throw new Error('Please connect your wallet')
        }
        
        if (!isOnL1) {
          switchChain({ chainId: config.l1ChainId })
          return
        }
        
        const value = parseEther(amount)
        
        // Create withdrawal transaction using Facet SDK
        // This creates an L2 transaction via L1
        const l2ETHBridgeAbi = [
          {
            name: 'initiateWithdrawal',
            type: 'function',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' }
            ],
            outputs: [],
            stateMutability: 'nonpayable'
          }
        ] as const
        
        // Ensure wallet is fully initialized
        if (!walletClient.chain || !walletClient.account) {
          throw new Error('Wallet not fully initialized - please reconnect')
        }
        
        const hash = await writeFacetContract(walletClient, {
          address: config.l2BridgeAddress,
          abi: l2ETHBridgeAbi,
          functionName: 'initiateWithdrawal',
          args: [address, value],
          chain: walletClient.chain,
          account: walletClient.account
        })
        
        setPendingTxHash(hash)
        setTxStatus('pending')
        setWithdrawalAmount(value)
        
        // Wait for the L1 transaction to be confirmed
        const receipt = await l1PublicClient.waitForTransactionReceipt({ hash })
        
        if (receipt.status === 'success') {
          setTxStatus('confirmed')
          
          // Set the receipt to trigger the cross-domain message hook
          setL1Receipt(receipt)
          // The hook will handle polling for the MessagePassed event
        } else {
          throw new Error('Transaction failed')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process withdrawal')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-ink mb-4">Step 1: Initiate Withdrawal</h3>
      
      {/* Mode selector */}
      <div className="flex mb-6 bg-inset rounded-lg p-1">
        <button
          type="button"
          onClick={() => setMode('new')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            mode === 'new' 
              ? 'bg-surface text-ink ' 
              : 'text-dim hover:text-ink'
          }`}
        >
          New Withdrawal
        </button>
        <button
          type="button"
          onClick={() => setMode('existing')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            mode === 'existing' 
              ? 'bg-surface text-ink ' 
              : 'text-dim hover:text-ink'
          }`}
        >
          Existing Transaction
        </button>
      </div>
      
      {mode === 'new' && (
        <>
          {/* L2 Balance */}
          <div className="mb-4 p-4 bg-accent-soft rounded-lg">
            <p className="text-sm text-dim">L2 Balance (Facet)</p>
            <p className="text-lg font-semibold">{formatEther(l2Balance)} {TOKEN_SYMBOL}</p>
          </div>
          
          {!isOnL1 && (
            <div className="mb-4 p-4 bg-warn-soft border border-warn-line rounded-lg">
              <p className="text-sm text-warn">
                You need to be on {getL1Chain().name} to initiate withdrawals. 
                <button
                  onClick={() => switchChain({ chainId: config.l1ChainId })}
                  className="ml-2 text-warn underline hover:text-ink"
                >
                  Switch to {getL1Chain().name}
                </button>
              </p>
            </div>
          )}
        </>
      )}
      

      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'new' ? (
          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-dim mb-2">
              Amount to Withdraw
            </label>
            <div className="relative">
              <input
                id="amount"
                type="number"
                step="0.001"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.01"
                className="w-full px-3 py-2 pr-12 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
                disabled={loading || !isOnL1}
              />
              <span className="absolute right-3 top-2.5 text-faint">ETH</span>
            </div>
            <p className="mt-1 text-xs text-faint">
              Enter the amount of ETH to withdraw from Facet
            </p>
          </div>
        ) : (
          <div>
            <label htmlFor="txHash" className="block text-sm font-medium text-dim mb-2">
              L2 Withdrawal Transaction Hash
            </label>
            <input
              id="txHash"
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x..."
              className="w-full px-3 py-2 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              disabled={loading || !isOnL2}
            />
            <p className="mt-1 text-xs text-faint">
              Enter the transaction hash from your L2 withdrawal
            </p>
          </div>
        )}

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
              {txStatus === 'pending' && '⏳ Withdrawal transaction pending... Hash: '}
              {txStatus === 'confirmed' && '✅ Withdrawal initiated! Hash: '}
              {pendingTxHash.slice(0, 10)}...{pendingTxHash.slice(-8)}
            </p>
            {txStatus === 'pending' && (
              <p className="text-xs text-link mt-1">Waiting for L1 confirmation...</p>
            )}
            {txStatus === 'confirmed' && !isPolling && (
              <p className="text-xs text-ok mt-1">L1 transaction confirmed. Waiting for L2 event...</p>
            )}
          </div>
        )}

        {isPolling && (
          <div className="mt-4 p-4 bg-accent-soft border border-accent-line rounded-lg">
            <p className="text-sm text-dim font-medium">
              Scanning L2 blocks for withdrawal event...
            </p>
            <p className="text-xs text-link mt-1">
              {scanProgress.currentBlock ? (
                <>Current block: #{scanProgress.currentBlock.toString()}</>
              ) : (
                <>Starting scan...</>
              )}
              {' '}({scanProgress.elapsedSeconds}s elapsed)
            </p>
            {scanProgress.elapsedSeconds > 30 && (
              <p className="text-xs text-link mt-2">
                This can take up to 5 minutes during high network activity.
              </p>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={
            loading || 
            isPolling ||
            (mode === 'new' ? (!amount || !isOnL1) : !txHash)
          }
          className="w-full py-2 px-4 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:bg-line disabled:cursor-not-allowed transition-colors"
        >
          {loading || isPolling ? 'Processing...' : mode === 'new' ? 'Initiate Withdrawal' : 'Continue'}
        </button>
      </form>

      <div className="mt-6 p-4 bg-inset rounded-lg">
        <h4 className="text-sm font-medium text-dim mb-2">How it works</h4>
        <p className="text-xs text-dim">
          {mode === 'new' 
            ? 'Withdrawals on Facet are initiated through L1 transactions. The Facet SDK will create the appropriate L1 transaction to initiate your L2 withdrawal.'
            : 'If you already have a withdrawal transaction, enter its hash to track and complete the withdrawal process.'
          }
        </p>
      </div>
    </div>
  )
}