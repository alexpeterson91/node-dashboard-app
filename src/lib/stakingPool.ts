import { Contract, ethers } from 'ethers'
import BigNumber from 'bignumber.js'
import { TransactionResponse, Web3Provider } from '@ethersproject/providers'
import BRIDGE_ABI from '../artifacts/BridgeToken.json'
import { abi as UNI_ABI } from '../artifacts/UNI.json'
import { abi as LM_ABI } from '../artifacts/UnipoolVested.json'
import config from '../configuration'
import { StakePoolInfo, StakeUserInfo } from '../types/poolInfo'
import { networkProviders } from './networkProvider'
import * as stakeToast from './notifications/stake'
import * as harvestToast from './notifications/harvest'
import * as withdrawToast from './notifications/withdraw'
import { isMainnet } from './web3-utils'

const { MAINNET_CONFIG } = config
const toBigNumber = (eb: ethers.BigNumber): BigNumber =>
	new BigNumber(eb.toString())

export const fetchStakePoolInfo = async (
	poolAddress: string,
	lmAddress: string,
	network: number,
	hasLiquidityPool: boolean,
): Promise<StakePoolInfo> => {
	const provider = networkProviders[network]
	const lmContract = new Contract(lmAddress, LM_ABI, provider)

	let APR
	let totalSupply
	let reserves
	let poolTotalSupply

	if (hasLiquidityPool) {
		const poolContract = new Contract(poolAddress, UNI_ABI, provider)
		const [
			_reserves,
			_token0,
			_pooltotalSupply,
			_totalSupply,
			_rewardRate,
		]: [
			Array<ethers.BigNumber>,
			string,
			ethers.BigNumber,
			ethers.BigNumber,
			ethers.BigNumber,
		] = await Promise.all([
			poolContract.getReserves(),
			poolContract.token0(),
			poolContract.totalSupply(),
			lmContract.totalSupply(),
			lmContract.rewardRate(),
		])

		totalSupply = _totalSupply
		reserves = _reserves
		poolTotalSupply = _pooltotalSupply

		const [_reserve0, _reserve1] = _reserves
		const reserve =
			_token0.toLowerCase() === MAINNET_CONFIG.TOKEN_ADDRESS.toLowerCase()
				? toBigNumber(_reserve0)
				: toBigNumber(_reserve1)
		const lp = toBigNumber(_pooltotalSupply)
			.times(10 ** 18)
			.div(2)
			.div(reserve)
		APR = _totalSupply.isZero()
			? null
			: toBigNumber(_rewardRate)
					.times('31536000')
					.times('100')
					.div(toBigNumber(_totalSupply))
					.times(lp)
					.div(10 ** 18)
	} else {
		const [_totalSupply, _rewardRate]: [
			ethers.BigNumber,
			ethers.BigNumber,
		] = await Promise.all([
			lmContract.totalSupply(),
			lmContract.rewardRate(),
		])

		totalSupply = _totalSupply
		APR = _totalSupply.isZero()
			? null
			: toBigNumber(_rewardRate)
					.times('31536000')
					.times('100')
					.div(_totalSupply.toString())
	}

	return {
		tokensInPool: toBigNumber(totalSupply),
		stakedLpTokens: 0,
		APR,
		earned: {
			amount: new BigNumber(0),
			token: 'NODE',
			displayToken: 'NODE',
		},
		reserves,
		poolTotalSupply,
	}
}

export const fetchUserInfo = async (
	address: string,
	poolAddress: string,
	lmAddress: string,
	network: number,
): Promise<StakeUserInfo> => {
	const provider = networkProviders[network]

	let validAddress = ''
	try {
		validAddress = ethers.utils.getAddress(address)
	} catch (_) {
		return {
			earned: {
				amount: new BigNumber(0),
				token: config.TOKEN_NAME,
				displayToken: config.TOKEN_NAME,
			},
			stakedLpTokens: 0,
		}
	}

	const lmContract = new Contract(lmAddress, LM_ABI, provider)
	const poolContract = new Contract(poolAddress, UNI_ABI, provider)

	const [stakedLpTokens, earned, notStakedLpTokensWei, allowanceLpTokens] =
		await Promise.all([
			lmContract.balanceOf(validAddress),
			lmContract.earned(validAddress),
			poolContract.balanceOf(validAddress),
			poolContract.allowance(validAddress, lmAddress),
		])

	return {
		stakedLpTokens: new BigNumber(ethers.utils.formatEther(stakedLpTokens)),
		earned: {
			amount: new BigNumber(ethers.utils.formatEther(earned)),
			token: config.TOKEN_NAME,
			displayToken: isMainnet(network) ? 'NODE' : 'xNODE',
		},
		notStakedLpTokensWei: notStakedLpTokensWei.toString(),
		allowanceLpTokens: allowanceLpTokens.toString(),
	}
}

async function permitTokensMainnet(provider, poolAddress, lmAddress, amount) {
	const signer = provider.getSigner()
	const signerAddress = await signer.getAddress()

	const poolContract = new Contract(poolAddress, UNI_ABI, signer)

	const domain = {
		name: await poolContract.name(),
		version: '1',
		chainId: provider.network.chainId,
		verifyingContract: poolAddress,
	}

	// The named list of all type definitions
	const types = {
		Permit: [
			{ name: 'owner', type: 'address' },
			{ name: 'spender', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'deadline', type: 'uint256' },
		],
	}

	// The data to sign
	const value = {
		owner: signerAddress,
		spender: lmAddress,
		value: amount,
		nonce: await poolContract.nonces(signerAddress),
		deadline: ethers.constants.MaxUint256,
	}

	// eslint-disable-next-line no-underscore-dangle
	const rawSignature = await signer._signTypedData(domain, types, value)
	const signature = ethers.utils.splitSignature(rawSignature)

	const rawPermitCall = await poolContract.populateTransaction.permit(
		signerAddress,
		lmAddress,
		amount,
		ethers.constants.MaxUint256,
		signature.v,
		signature.r,
		signature.s,
	)

	return rawPermitCall
}

async function permitTokensXDai(provider, poolAddress, lmAddress) {
	const signer = provider.getSigner()
	const signerAddress = await signer.getAddress()

	const poolContract = new Contract(poolAddress, BRIDGE_ABI, signer)

	const domain = {
		name: await poolContract.name(),
		version: '1',
		chainId: provider.network.chainId,
		verifyingContract: poolContract.address,
	}

	// The named list of all type definitions
	const types = {
		Permit: [
			{ name: 'holder', type: 'address' },
			{ name: 'spender', type: 'address' },
			{ name: 'nonce', type: 'uint256' },
			{ name: 'expiry', type: 'uint256' },
			{ name: 'allowed', type: 'bool' },
		],
	}

	const nonce = await poolContract.nonces(signerAddress)
	const expiry = Math.floor(Date.now() / 1000) + 3600
	const value = {
		holder: signerAddress,
		spender: lmAddress,
		nonce,
		expiry,
		allowed: true,
	}

	// eslint-disable-next-line no-underscore-dangle
	const rawSignature = await signer._signTypedData(domain, types, value)
	const sign = ethers.utils.splitSignature(rawSignature)

	const rawPermitCall = await poolContract.populateTransaction.permit(
		signerAddress,
		lmAddress,
		nonce,
		expiry,
		true,
		sign.v,
		sign.r,
		sign.s,
	)

	return rawPermitCall
}

export async function stakeTokens(
	amount: string,
	poolAddress: string,
	lmAddress: string,
	provider: Web3Provider,
): Promise<TransactionResponse> {
	if (amount === '0') return

	const signer = provider.getSigner()

	const lmContract = new Contract(lmAddress, LM_ABI, signer)

	const rawPermitCall =
		provider.network.chainId === config.MAINNET_NETWORK_NUMBER
			? await permitTokensMainnet(
					provider,
					poolAddress,
					lmAddress,
					amount,
			  )
			: await permitTokensXDai(provider, poolAddress, lmAddress)

	const txResponse: TransactionResponse = await lmContract
		.connect(signer.connectUnchecked())
		.stakeWithPermit(
			ethers.BigNumber.from(amount.toString()),
			rawPermitCall.data,
			{
				gasLimit: 300_000,
			},
		)

	stakeToast.showPendingStake(
		ethers.utils.formatEther(amount),
		provider.network.chainId,
		txResponse.hash,
	)

	const { status } = await txResponse.wait()

	if (status) {
		stakeToast.showConfirmedStake(provider.network.chainId, txResponse.hash)
	} else {
		stakeToast.showFailedStake(provider.network.chainId, txResponse.hash)
	}
}

export async function approve(
	amount: string,
	poolAddress: string,
	lmAddress: string,
	provider: Web3Provider,
): Promise<TransactionResponse> {
	if (amount === '0') return

	const signer = provider.getSigner()

	const poolContract = new Contract(poolAddress, UNI_ABI, provider)
	const txResponse: TransactionResponse = await poolContract
		.connect(signer.connectUnchecked())
		.approve(lmAddress, amount)

	stakeToast.showPendingApproval(provider.network.chainId, txResponse.hash)

	const { status } = await txResponse.wait()

	if (status) {
		stakeToast.showConfirmedApproval(
			provider.network.chainId,
			txResponse.hash,
		)
	} else {
		stakeToast.showFailedApproval(provider.network.chainId, txResponse.hash)
	}
}

export async function stakeTokensWithoutPermit(
	amount: string,
	poolAddress: string,
	lmAddress: string,
	provider: Web3Provider,
): Promise<TransactionResponse> {
	if (amount === '0') return

	const signer = provider.getSigner()

	const lmContract = new Contract(lmAddress, LM_ABI, signer)
	const txResponse: TransactionResponse = await lmContract
		.connect(signer.connectUnchecked())
		.stake(amount)

	const { status } = await txResponse.wait()

	if (status) {
		stakeToast.showConfirmedStake(provider.network.chainId, txResponse.hash)
	} else {
		stakeToast.showFailedStake(provider.network.chainId, txResponse.hash)
	}
}

export const harvestTokens = async (
	lmAddress: string,
	network: number,
	signer,
) => {
	const lmContract = new Contract(
		lmAddress,
		LM_ABI,
		signer.connectUnchecked(),
	)

	const tx = await lmContract.getReward()

	harvestToast.showPendingHarvest(network, tx.hash)

	const { status } = await tx.wait()

	if (status) {
		harvestToast.showConfirmedHarvest(network, tx.hash)
	} else {
		harvestToast.showFailedHarvest(network, tx.hash)
	}
}

export const withdrawTokens = async (
	amount: number,
	lmAddress: string,
	network: number,
	signer,
) => {
	const lmContract = new Contract(
		lmAddress,
		LM_ABI,
		signer.connectUnchecked(),
	)

	const tx = await lmContract.withdraw(ethers.BigNumber.from(amount))

	withdrawToast.showPendingWithdraw(network, tx.hash)

	const { status } = await tx.wait()

	if (status) {
		withdrawToast.showConfirmedWithdraw(network, tx.hash)
	} else {
		withdrawToast.showFailedWithdraw(network, tx.hash)
	}
}
