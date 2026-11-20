'use client'

import { useState } from 'react'
import { WalletButton } from '@/components/wallet-button'
import { NetworkStatus } from '@/components/network-status'
import { WithdrawalWizard } from '@/components/withdrawal-wizard'
import { DepositWizard } from '@/components/deposit-wizard'
import { ContractsFooter } from '@/components/contracts-footer'
import { BridgeEducation } from '@/components/bridge-education'
import { BRIDGE_NAME } from '@/lib/config'

export default function Home() {
  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit')
  
  const tab = (key: 'deposit' | 'withdraw', label: string) => (
    <button
      onClick={() => setActiveTab(key)}
      aria-pressed={activeTab === key}
      className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
        activeTab === key ? 'bg-surface text-ink' : 'text-dim hover:text-ink'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="min-h-dvh bg-canvas flex flex-col">
      <header className="border-b border-line">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <span className="font-semibold text-ink whitespace-nowrap">{BRIDGE_NAME}</span>
          <div className="flex items-center gap-4">
            <NetworkStatus />
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 pt-14 pb-16">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-tight text-ink">
          Bridge ETH between Ethereum and Facet
        </h1>
        <p className="mt-4 text-lg text-dim">
          No admin, no guardian, no training wheels. Deposits are instant; withdrawals take about 7 days.
        </p>
        <div className="mt-10 mb-4 inline-flex rounded-lg border border-line bg-inset p-1">
          {tab('deposit', 'Deposit')}
          {tab('withdraw', 'Withdraw')}
        </div>

        {activeTab === 'deposit' ? <DepositWizard /> : <WithdrawalWizard />}

        <BridgeEducation />
      </main>

      <ContractsFooter />
    </div>
  )
}
