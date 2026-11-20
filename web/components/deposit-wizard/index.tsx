'use client'

import { useState, useEffect } from 'react'
import { useAccount, useBalance, useWalletClient, useChainId, useSwitchChain } from 'wagmi'
import { formatEther, parseEther } from 'viem'
import { config, l1PublicClient, l2PublicClient, TOKEN_SYMBOL, getL1Chain } from '@/lib/config'
import { L1_BRIDGE_ABI, L2_BRIDGE_ABI } from '@/lib/contracts'

export function DepositWizard() {
  const { address, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [txStatus, setTxStatus] = useState<'pending' | 'confirmed' | null>(null)
  
  const isOnL1 = chainId === config.l1ChainId
  
  // Get L1 balance
  const { data: l1Balance } = useBalance({
    address,
    chainId: config.l1ChainId,
  })
  
  // Get L2 ERC20 balance
  const [l2Balance, setL2Balance] = useState<bigint>(0n)
  
  useEffect(() => {
    async function fetchL2Balance() {
      if (!address) return
      
      try {
        const balance = await l2PublicClient.readContract({
          address: config.l2BridgeAddress,
          abi: L2_BRIDGE_ABI,
          functionName: 'balanceOf',
          args: [address]
        })
        setL2Balance(balance)
      } catch (err) {
        console.error('Failed to fetch L2 balance:', err)
      }
    }
    
    fetchL2Balance()
    const interval = setInterval(fetchL2Balance, 5000) // Poll every 5 seconds
    return () => clearInterval(interval)
  }, [address])
  
  const handleDeposit = async () => {
    if (!walletClient || !address) {
      setError('Please connect your wallet')
      return
    }
    
    if (!isOnL1) {
      switchChain({ chainId: config.l1ChainId })
      return
    }
    
    setLoading(true)
    setError(null)
    
    try {
      const value = parseEther(amount)
      
      // Call initiateDeposit function on L1 bridge
      const hash = await walletClient.writeContract({
        address: config.l1BridgeAddress,
        abi: L1_BRIDGE_ABI,
        functionName: 'initiateDeposit',
        args: [address], // deposit to user's own address
        value,
      })
      
      setTxHash(hash)
      setTxStatus('pending')
      
      // Wait for confirmation
      const receipt = await l1PublicClient.waitForTransactionReceipt({ hash })
      
      if (receipt.status === 'success') {
        setTxStatus('confirmed')
        setAmount('')
        // Clear the transaction after showing success for a few seconds
        setTimeout(() => {
          setTxHash(null)
          setTxStatus(null)
        }, 5000)
        // The L2 balance will update via polling
      } else {
        throw new Error('Transaction failed')
      }
    } catch (err) {
      console.error('Deposit error:', err)
      setError(err instanceof Error ? err.message : 'Failed to deposit')
    } finally {
      setLoading(false)
    }
  }
  
  if (!isConnected) {
    return (
      <div className="p-5 sm:p-7 bg-surface rounded-xl border border-line ">
        <h2 className="text-2xl font-bold mb-4">Deposit to Facet</h2>
        <p className="text-dim mb-6">
          Connect your wallet to deposit ETH to Facet.
        </p>
      </div>
    )
  }
  
  return (
    <div className="p-5 sm:p-7 bg-surface rounded-xl border border-line ">
      <h2 className="text-2xl font-bold text-ink mb-6">Deposit ETH to Facet</h2>
      
      {/* Balance Display */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="p-4 bg-inset rounded-lg">
          <p className="text-sm font-medium text-dim">L1 Balance</p>
          <p className="text-lg font-semibold text-ink">
            {l1Balance ? formatEther(l1Balance.value) : '0'} ETH
          </p>
        </div>
        <div className="p-4 bg-accent-soft rounded-lg">
          <p className="text-sm font-medium text-dim">L2 Balance</p>
          <p className="text-lg font-semibold text-ink">
            {formatEther(l2Balance)} {TOKEN_SYMBOL}
          </p>
          <p className="text-xs text-dim mt-1">ERC20: {config.l2BridgeAddress.slice(0, 6)}...{config.l2BridgeAddress.slice(-4)}</p>
        </div>
      </div>
      
      {!isOnL1 && (
        <div className="mb-4 p-4 bg-warn-soft border border-warn-line rounded-lg">
          <p className="text-sm text-warn">
            You need to be on {getL1Chain().name} to deposit. 
            <button
              onClick={() => switchChain({ chainId: config.l1ChainId })}
              className="ml-2 text-warn underline hover:text-ink"
            >
              Switch to {getL1Chain().name}
            </button>
          </p>
        </div>
      )}
      
      {/* Deposit Form */}
      <div className="space-y-4">
        <div>
          <label htmlFor="amount" className="block text-sm font-medium text-ink mb-2">
            Amount to Deposit
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
              className="w-full text-ink px-3 py-2 pr-12 border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              disabled={loading || !isOnL1}
            />
            <span className="absolute right-3 top-2.5 text-dim font-medium">ETH</span>
          </div>
        </div>
        
        {error && (
          <div className="p-3 bg-err-soft border border-err-line rounded-lg">
            <p className="text-sm text-err">{error}</p>
          </div>
        )}
        
        {txHash && (
          <div className={`p-3 border rounded-lg ${
            txStatus === 'confirmed' 
              ? 'bg-ok-soft border-ok-line' 
              : 'bg-accent-soft border-accent-line'
          }`}>
            <p className={`text-sm ${
              txStatus === 'confirmed' ? 'text-ok' : 'text-dim'
            }`}>
              {txStatus === 'pending' && '⏳ Transaction pending... Hash: '}
              {txStatus === 'confirmed' && '✅ Transaction confirmed! Hash: '}
              {txHash.slice(0, 10)}...{txHash.slice(-8)}
            </p>
            {txStatus === 'pending' && (
              <p className="text-xs text-link mt-1">Waiting for confirmation...</p>
            )}
            {txStatus === 'confirmed' && (
              <p className="text-xs text-ok mt-1">Your L2 balance will update shortly.</p>
            )}
          </div>
        )}
        
        <p className="p-3 bg-warn-soft border border-warn-line rounded-lg text-xs text-warn">
          <strong>Use at your own risk.</strong> The contracts are unaudited, and they or the ZK proof system they rely
          on may have bugs. Nothing in this deployment can be upgraded or swapped out, so a bug can&apos;t be fixed here
          and lost funds can&apos;t be recovered. Only deposit what you can afford to lose.
        </p>

        <button
          onClick={handleDeposit}
          disabled={loading || !amount || !isOnL1}
          className="w-full py-2 px-4 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:bg-line disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Depositing...' : `Deposit to Facet`}
        </button>
      </div>
    </div>
  )
}