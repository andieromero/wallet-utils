import * as google_protobuf_any_pb from 'google-protobuf/google/protobuf/any_pb';
import { Message } from 'google-protobuf';
import type { Wallet } from '@tendermint/sig';
import type { Bytes } from '@tendermint/types';
import { base64ToBytes, bufferToBytes, bytesToBase64 } from '@tendermint/belt';
import { MsgExecuteContract } from '../proto/cosmwasm/wasm/v1/tx_pb';
import { createHash } from 'crypto';
import { ecdsaSign as secp256k1EcdsaSign } from 'secp256k1';
import {
  MESSAGE_PROTOS,
  CoinAsObject,
  MsgBeginRedelegateDisplay,
  MsgCreateValidatorDisplay,
  MsgCreateVestingAccountDisplay,
  MsgDelegateDisplay,
  MsgDepositDisplay,
  MsgEditValidatorDisplay,
  MsgExecuteContractParams,
  MsgFundCommunityPoolDisplay,
  MsgGrantDisplay,
  MsgSendDisplay,
  MsgSetWithdrawAddressDisplay,
  MsgSubmitEvidenceDisplay,
  MsgSubmitProposalDisplay,
  MsgUndelegateDisplay,
  MsgUnjailDisplay,
  MsgVerifyInvariantDisplay,
  MsgVoteDisplay,
  MsgVoteWeightedDisplay,
  MsgWithdrawDelegatorRewardDisplay,
  MsgWithdrawValidatorCommissionDisplay,
  ReadableMessageNames,
  TYPE_NAMES_READABLE_MAP,
  SupportedMessageTypeNames,
} from '../types';
import { BaseAccount } from '../proto/cosmos/auth/v1beta1/auth_pb';
import { Coin } from '../proto/cosmos/base/v1beta1/coin_pb';
import { MsgSend } from '../proto/cosmos/bank/v1beta1/tx_pb';
import { MsgDelegate } from '../proto/cosmos/staking/v1beta1/tx_pb';
import { PubKey } from '../proto/cosmos/crypto/secp256k1/keys_pb';
import {
  AuthInfo,
  Fee,
  ModeInfo,
  SignDoc,
  SignerInfo,
  TxBody,
  TxRaw,
} from '../proto/cosmos/tx/v1beta1/tx_pb';
import { CalculateTxFeesRequest } from '../proto/provenance/msgfees/v1/query_pb';
import { SignMode } from '../proto/cosmos/tx/signing/v1beta1/signing_pb';
import {
  BroadcastMode,
  BroadcastTxRequest,
} from '../proto/cosmos/tx/v1beta1/service_pb';
import { MsgAddMarkerRequest } from '../proto/provenance/marker/v1/tx_pb';
import { MarkerStatus, MarkerType } from '../proto/provenance/marker/v1/marker_pb';
import { Access } from '../proto/provenance/marker/v1/accessgrant_pb';
import { formatCustomObj, formatSingleValue, getJSType } from '../utils';
import { isMatching, P } from 'ts-pattern';

export type GenericDisplay = { [key: string]: any };

export type MsgExecuteContractDisplay = {
  sender: string;
  msg: any;
  fundsList: CoinAsObject[];
};

export type FallbackGenericMessageName = 'MsgGeneric' | 'MsgExecuteContractGeneric';

export const buildAuthInfo = (
  signerInfo: SignerInfo,
  feeDenom: string,
  feeEstimate: CoinAsObject[] = [],
  gasLimit: number
): AuthInfo => {
  //
  // TODO: Move feeList into it's own function and add unit tests
  //

  //
  // This is to support a list of fees of any denom
  // calculateTxFees should give a totalFeesList back
  // that list is used here, only after you have added the gasFee to it
  // which should be the estimatedGas amount received from calculateTxFees
  // and multiplied by the desired gasPrice
  const feeList = feeEstimate
    .reduce((agg: CoinAsObject[], curr: CoinAsObject) => {
      // Find if the same coin is already in the aggregated list
      const sameCoin = agg.find((i) => i.denom === curr.denom);
      if (sameCoin) {
        // if it is find the index of it
        const sameCoinInd = agg.findIndex((i) => i.denom === sameCoin.denom);
        // create a new array from the aggregate so we don't mutate it
        const result = [...agg];
        // change the item in place to add the current amount to whatever it currently is
        result[sameCoinInd] = {
          amount: +sameCoin.amount + +curr.amount,
          denom: curr.denom,
        };
        // return the resulting array
        return result;
      }

      // if the coin wasn't already in the aggregate just add it to the aggregate here
      return [...agg, curr];
    }, [])
    // sort by denom name in ascending order (assumes all denoms are lowercase)
    .sort((a, b) => (a.denom > b.denom ? 1 : -1))
    .map((feeItem) => {
      // map each feeItem and create a coin out of it
      const feeCoin = new Coin();
      feeCoin.setDenom(feeItem.denom);
      // since the amount can be a string or number we convert it to a string here
      feeCoin.setAmount(feeItem.amount.toString());
      return feeCoin;
    });

  const fee = new Fee();
  fee.setAmountList(feeList);
  fee.setGasLimit(gasLimit);
  const authInfo = new AuthInfo();
  authInfo.setFee(fee);
  authInfo.setSignerInfosList([signerInfo].filter((f) => f));
  return authInfo;
};

export const buildSignerInfo = (
  baseAccount: BaseAccount,
  pubKeyBytes: Bytes
): SignerInfo => {
  const single = new ModeInfo.Single();
  single.setMode(SignMode.SIGN_MODE_DIRECT);
  const modeInfo = new ModeInfo();
  modeInfo.setSingle(single);
  const signerInfo = new SignerInfo();
  const pubKey = new PubKey();
  pubKey.setKey(pubKeyBytes);
  const pubKeyAny = new google_protobuf_any_pb.Any();
  pubKeyAny.pack(pubKey.serializeBinary(), TYPE_NAMES_READABLE_MAP.PubKey, '/');
  signerInfo.setPublicKey(pubKeyAny);
  signerInfo.setModeInfo(modeInfo);
  signerInfo.setSequence(baseAccount.getSequence());
  return signerInfo;
};

export const buildTxBody = (
  msgAny: google_protobuf_any_pb.Any | google_protobuf_any_pb.Any[],
  memo: string = ''
): TxBody => {
  const txBody = new TxBody();
  if (Array.isArray(msgAny)) txBody.setMessagesList(msgAny);
  else txBody.addMessages(msgAny);
  txBody.setMemo(memo);
  return txBody;
};

export const buildSignDoc = (
  accNumber: number,
  chainId: string,
  txRaw: TxRaw
): SignDoc => {
  const signDoc = new SignDoc();
  signDoc.setAccountNumber(accNumber);
  signDoc.setAuthInfoBytes(txRaw.getAuthInfoBytes());
  signDoc.setChainId(chainId);
  signDoc.setBodyBytes(txRaw.getBodyBytes());
  return signDoc;
};

export const sha256 = (bytes: Bytes): Bytes => {
  const buffer1 = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  const buffer2 = createHash('sha256').update(buffer1).digest();

  return bufferToBytes(buffer2);
};

export const signBytes = (bytes: Uint8Array, privateKey: Bytes): Uint8Array => {
  const hash = sha256(bytes);
  const { signature } = secp256k1EcdsaSign(hash, privateKey);

  return signature;
};

interface CalculateTxFeesRequestParams {
  msgAny: google_protobuf_any_pb.Any | google_protobuf_any_pb.Any[];
  account: BaseAccount;
  publicKey: Bytes;
  gasPriceDenom?: string;
  gasLimit: number;
  gasAdjustment?: number;
}

export const buildCalculateTxFeeRequest = ({
  msgAny,
  account,
  publicKey,
  gasPriceDenom = 'nhash',
  gasLimit,
  gasAdjustment = 1.25,
}: CalculateTxFeesRequestParams): CalculateTxFeesRequest => {
  const signerInfo = buildSignerInfo(account, publicKey);
  const authInfo = buildAuthInfo(signerInfo, gasPriceDenom, undefined, gasLimit);
  const txBody = buildTxBody(msgAny);
  const txRaw = new TxRaw();
  txRaw.setBodyBytes(txBody.serializeBinary());
  txRaw.setAuthInfoBytes(authInfo.serializeBinary());
  txRaw.setSignaturesList(['']);

  const calculateTxFeeRequest = new CalculateTxFeesRequest();
  calculateTxFeeRequest.setTxBytes(txRaw.serializeBinary());
  calculateTxFeeRequest.setDefaultBaseDenom(gasPriceDenom);
  calculateTxFeeRequest.setGasAdjustment(gasAdjustment);
  return calculateTxFeeRequest;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const buildMessage = (
  type: ReadableMessageNames,
  params:
    | MsgSendDisplay
    | MsgExecuteContractParams
    | MsgGrantDisplay
    | MsgVerifyInvariantDisplay
    | MsgSetWithdrawAddressDisplay
    | MsgWithdrawDelegatorRewardDisplay
    | MsgWithdrawValidatorCommissionDisplay
    | MsgFundCommunityPoolDisplay
    | MsgSubmitEvidenceDisplay
    | MsgSubmitProposalDisplay
    | MsgVoteDisplay
    | MsgVoteWeightedDisplay
    | MsgDepositDisplay
    | MsgUnjailDisplay
    | MsgCreateValidatorDisplay
    | MsgEditValidatorDisplay
    | MsgDelegateDisplay
    | MsgBeginRedelegateDisplay
    | MsgUndelegateDisplay
    | MsgCreateVestingAccountDisplay
) => {
  switch (type) {
    case 'MsgDelegate': {
      const { delegatorAddress, validatorAddress, amount } =
        params as MsgDelegateDisplay;
      const msgDelegate = new MsgDelegate()
        .setDelegatorAddress(delegatorAddress)
        .setValidatorAddress(validatorAddress);
      if (amount) {
        msgDelegate.setAmount(
          new Coin().setAmount(`${amount.amount}`).setDenom(amount.denom)
        );
      }
      return msgDelegate;
    }

    case 'MsgSend': {
      const { fromAddress, toAddress, amountList } = params as MsgSendDisplay;
      const msgSend = new MsgSend()
        .setFromAddress(fromAddress)
        .setToAddress(toAddress);
      amountList.forEach(({ denom, amount }) => {
        msgSend.addAmount(new Coin().setAmount(`${amount}`).setDenom(denom));
      });
      return msgSend;
    }

    case 'MsgExecuteContract': {
      const { sender, contract, msg, fundsList } =
        params as MsgExecuteContractParams;
      const msgExecuteContract = new MsgExecuteContract()
        .setContract(contract)
        .setSender(sender)
        .setMsg(encoder.encode(JSON.stringify(msg)));
      if (fundsList)
        fundsList.forEach(({ denom, amount }) => {
          msgExecuteContract.addFunds(
            new Coin().setAmount(`${amount}`).setDenom(denom)
          );
        });
      return msgExecuteContract;
    }
  }
};

export const createAnyMessageBase64 = (
  type: ReadableMessageNames,
  msg: Message
): string => {
  const msgAny = new google_protobuf_any_pb.Any();
  msgAny.pack(msg.serializeBinary(), TYPE_NAMES_READABLE_MAP[type], '/');
  return bytesToBase64(msgAny.serializeBinary());
};

export const msgAnyB64toAny = (msgAnyB64: string): google_protobuf_any_pb.Any => {
  return google_protobuf_any_pb.Any.deserializeBinary(base64ToBytes(msgAnyB64));
};

interface buildBroadcastTxRequestProps {
  msgAny: google_protobuf_any_pb.Any | google_protobuf_any_pb.Any[];
  account: BaseAccount;
  chainId: string;
  wallet: Wallet;
  feeEstimate: CoinAsObject[];
  memo: string;
  feeDenom: string;
  gasLimit: number;
}

export const buildBroadcastTxRequest = ({
  msgAny,
  account,
  chainId,
  wallet,
  feeEstimate,
  memo = '',
  feeDenom = 'nhash',
  gasLimit,
}: buildBroadcastTxRequestProps): BroadcastTxRequest => {
  const signerInfo = buildSignerInfo(account, wallet.publicKey);
  const authInfo = buildAuthInfo(signerInfo, feeDenom, feeEstimate, gasLimit);
  const txBody = buildTxBody(msgAny, memo);
  const txRaw = new TxRaw();
  txRaw.setBodyBytes(txBody.serializeBinary());
  txRaw.setAuthInfoBytes(authInfo.serializeBinary());
  const signDoc = buildSignDoc(account.getAccountNumber(), chainId, txRaw);
  const signature = signBytes(signDoc.serializeBinary(), wallet.privateKey);
  txRaw.setSignaturesList([signature]);
  const txRequest = new BroadcastTxRequest();
  txRequest.setTxBytes(txRaw.serializeBinary());
  txRequest.setMode(BroadcastMode.BROADCAST_MODE_BLOCK);
  return txRequest;
};

/**
 * Unpacks an anyMsgBase64 string to a formatted JSON object. The
 * display object templates are mapped to {@link SupportedMessageTypeNames}.
 * The display object returned contains a typeName field representing
 * the given SupportedMessageTypeNames type (i.e. cosmos.bank.v1beta1.MsgSend -> MsgSend).
 */
export const unpackDisplayObjectFromWalletMessage = (
  anyMsgBase64: string
): (MsgSendDisplay | MsgExecuteContractDisplay | GenericDisplay) & {
  typeName: ReadableMessageNames | FallbackGenericMessageName;
} => {
  const msgBytes = base64ToBytes(anyMsgBase64);
  const msgAny = google_protobuf_any_pb.Any.deserializeBinary(msgBytes);
  const typeName = msgAny.getTypeName() as SupportedMessageTypeNames;
  if (MESSAGE_PROTOS[typeName]) {
    const message = msgAny.unpack(
      MESSAGE_PROTOS[typeName].deserializeBinary,
      typeName
    );
    switch (typeName) {
      case 'cosmos.bank.v1beta1.MsgSend':
        return {
          typeName: 'MsgSend',
          ...(message as MsgSend).toObject(),
        };
      case 'cosmwasm.wasm.v1.MsgExecuteContract':
        return {
          typeName: 'MsgExecuteContractGeneric',
          sender: (message as MsgExecuteContract).getSender(),
          msg: JSON.parse(
            decoder.decode((message as MsgExecuteContract).getMsg() as Uint8Array)
          ),
          fundsList: (message as MsgExecuteContract).getFundsList().map((coin) => ({
            denom: coin.getDenom(),
            amount: Number(coin.getAmount()),
          })),
        };
      case 'provenance.marker.v1.MsgAddMarkerRequest':
        const getKey = (map: { [key: string]: any }, val: any) =>
          Object.keys(map).find((key) => map[key] === val);

        return {
          typeName: 'MsgAddMarkerRequest',
          ...(message as MsgAddMarkerRequest).toObject(),
          markerType: getKey(
            MarkerType,
            (message as MsgAddMarkerRequest).getMarkerType()
          ),
          status: getKey(MarkerStatus, (message as MsgAddMarkerRequest).getStatus()),
          accessListList: (message as MsgAddMarkerRequest)
            .getAccessListList()
            .map((list) => {
              return {
                address: list.getAddress(),
                permissionsList: list
                  .getPermissionsList()
                  .map((perm) => getKey(Access, perm)),
              };
            }),
        };
      default:
        return {
          typeName: 'MsgGeneric',
          ...(message as Message).toObject(),
        };
    }
  }
  throw new Error(`Message type: ${typeName} is not supported for display.`);
};

const recurseFormatDisplayValue = (
  finalFlattenedDisplayObject: { [key: string]: any },
  currDisplayObject: { [key: string]: any },
  parentKey?: string
) => {
  Object.entries(currDisplayObject).forEach(([key, value]) => {
    const isStringOrNumberOrBool = ['string', 'number', 'boolean'].includes(
      typeof value
    );
    const isArrayOfObjects = isMatching(P.array({}), value);
    const isArrayOfStringsOrNumbers =
      isMatching(P.array(P.string), value) || isMatching(P.array(P.number), value);

    let currentFormattedValue: any;
    try {
      if (isStringOrNumberOrBool) {
        currentFormattedValue = formatSingleValue(key, value);
      } else {
        currentFormattedValue = formatCustomObj(key, value);
      }
    } catch (e) {
      console.error(e);
    }

    if (currentFormattedValue !== null) {
      parentKey
        ? (finalFlattenedDisplayObject[parentKey][key] = currentFormattedValue)
        : (finalFlattenedDisplayObject[key] = currentFormattedValue);
      return;
    }

    // Arrays are displayed as space delimited single values or recursed again.
    if (isArrayOfObjects || isArrayOfStringsOrNumbers) {
      // Array is all string/numbers (combine and display)
      if (isArrayOfStringsOrNumbers) {
        const currentFieldCombinedValue = value.join(`\n`);
        parentKey
          ? (finalFlattenedDisplayObject[parentKey][key] = currentFieldCombinedValue)
          : (finalFlattenedDisplayObject[key] = currentFieldCombinedValue);
        return;
      }
      // Array needs additional looping (object/array children)
      else {
        (value as any).forEach((cfArrayVal: any, index: number) => {
          const newCfName = value.length > 1 ? `${key} ${index + 1}` : key;
          finalFlattenedDisplayObject[newCfName] = {};
          recurseFormatDisplayValue(
            finalFlattenedDisplayObject,
            cfArrayVal,
            newCfName
          );
          return;
        });
      }
    }
    // Objects are also recursed again and passed a parent key.
    else {
      finalFlattenedDisplayObject[key] = {};
      recurseFormatDisplayValue(finalFlattenedDisplayObject, value, key);
      return;
    }
  });
};

/**
 * Formats a display object from {@link unpackDisplayObjectFromWalletMessage} by
 * recursing through the nested json object and formatting values based on
 * formatting functions {@link formatSingleValue} and {@link formatCustomObj}
 * that match keys and/or values to specific tests.
 */
export const formatDisplayObject = ({
  displayObject,
}: {
  displayObject: { [key: string]: any };
}) => {
  const finalMessage = {};
  if (displayObject) {
    Object.values(displayObject).reduce(
      () => recurseFormatDisplayValue(finalMessage, displayObject),
      {}
    );
  }
  return finalMessage;
};
