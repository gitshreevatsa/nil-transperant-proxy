import { task } from "hardhat/config";

import fs from "node:fs";
import {
  FaucetClient,
  HttpTransport,
  LocalECDSAKeySigner,
  PublicClient,
  SmartAccountV1,
  convertEthToWei,
  generateRandomPrivateKey,
  waitTillCompleted,
} from "@nilfoundation/niljs";
import { ethers } from "ethers";
import "dotenv/config";
import { decodeFunctionResult, encodeFunctionData } from "viem";

let smartAccount: SmartAccountV1 | null = null;

async function getSmartAccount(): Promise<SmartAccountV1> {
  const rpcEndpoint = process.env.NIL_RPC_ENDPOINT as string;
  const client = new PublicClient({
    transport: new HttpTransport({ endpoint: rpcEndpoint }),
  });
  const faucetClient = new FaucetClient({
    transport: new HttpTransport({ endpoint: rpcEndpoint }),
  });

  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
  const smartAccountAddress = process.env.SMART_ACCOUNT_ADDRESS as `0x${string}`;

  if (privateKey && smartAccountAddress) {
    const signer = new LocalECDSAKeySigner({ privateKey });
    smartAccount = new SmartAccountV1({
      signer,
      client,
      address: smartAccountAddress,
      pubkey: signer.getPublicKey(),
    });
    console.log("🟢 Loaded Smart Account:", smartAccount.address);
  } else {
    const newPrivateKey = generateRandomPrivateKey();
    const signer = new LocalECDSAKeySigner({ privateKey: newPrivateKey });
    smartAccount = new SmartAccountV1({
      signer,
      client,
      salt: BigInt(Math.floor(Math.random() * 10000)),
      shardId: 1,
      pubkey: signer.getPublicKey(),
    });
    fs.writeFileSync("smartAccount.json", JSON.stringify({
      PRIVATE_KEY: newPrivateKey,
      SMART_ACCOUNT_ADDRESS: smartAccount.address,
    }));
    console.log("🆕 New Smart Account Generated:", smartAccount.address);
  }

  const topUpFaucet = await faucetClient.topUp({
    smartAccountAddress: smartAccount.address,
    amount: ethers.parseEther("0.01"),
    faucetAddress: process.env.NIL as `0x${string}`,
  });

  await waitTillCompleted(client, topUpFaucet);

  if ((await smartAccount.checkDeploymentStatus()) === false) {
    await smartAccount.selfDeploy(true);
  }

  console.log("✅ Smart Account Funded (0.01 ETH)");
  return smartAccount;
}

task("deploy-transperant-proxy", "Deploys a transparent proxy contract")
  .setAction(async () => {
    const LogicContract = require("../artifacts/contracts/MyLogic.sol/MyLogic.json");
    const TransperantProxy = require("../artifacts/contracts/TransparentUpgradeableProxy.sol/MyTransparentUpgradeableProxy.json");
    const ProxyAdmin = require("../artifacts/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json");
    const MyLogicV2 = require("../artifacts/contracts/MyLogicV2.sol/MyLogicV2.json");

    const deployerAccount = await getSmartAccount();
    if (!smartAccount) throw new Error("SmartAccount is not initialized.");

    const { address: addressLogic, hash: hashLogic } = await deployerAccount.deployContract({
      shardId: 1,
      bytecode: LogicContract.bytecode,
      abi: LogicContract.abi,
      args: [],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: convertEthToWei(0.001),
    });
    await waitTillCompleted(deployerAccount.client, hashLogic);
    console.log("✅ Logic Contract deployed at:", addressLogic);

    const initData = encodeFunctionData({
      abi: LogicContract.abi,
      functionName: "initialize",
      args: [42],
    });

    console.log("Deploying Proxy with args:");
    console.log("Logic:", addressLogic);
    console.log("Admin:", smartAccount.address);
    console.log("Init data:", initData);

    const { address: addressProxy, hash: hashProxy } = await deployerAccount.deployContract({
      shardId: 1,
      bytecode: TransperantProxy.bytecode,
      abi: TransperantProxy.abi,
      args: [addressLogic, smartAccount.address, initData],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: convertEthToWei(0.001),
    });
    await waitTillCompleted(deployerAccount.client, hashProxy);
    console.log("✅ Transparent Proxy Contract deployed at:", addressProxy);

    console.log("Waiting 5 seconds...");
    await new Promise((res) => setTimeout(res, 5000));

    const fetchAdminCall = encodeFunctionData({
      abi: TransperantProxy.abi,
      functionName: "fetchAdmin",
      args: [],
    });

    const adminResult = await smartAccount.client.call({
      to: addressProxy,
      data: fetchAdminCall,
      from: smartAccount.address,
    }, "latest");

    const proxyAdminAddress = decodeFunctionResult({
      abi: TransperantProxy.abi,
      functionName: "fetchAdmin",
      data: adminResult.data,
    }) as string;

    console.log("✅ ProxyAdmin Address:", proxyAdminAddress);

    const owner = encodeFunctionData({
        abi: ProxyAdmin.abi,
        functionName: "owner",
        args: [],
    })

    const ownerResult = await smartAccount.client.call({
      to: proxyAdminAddress as `0x${string}`,
      data: owner,
      from: smartAccount.address,
    }, "latest");

    const proxyAdminOwner = decodeFunctionResult({
      abi: ProxyAdmin.abi,
      functionName: "owner",
      data: ownerResult.data,
    }) as string;

    console.log("✅ ProxyAdmin Owner:", proxyAdminOwner);

    const getValueData = encodeFunctionData({
      abi: LogicContract.abi,
      functionName: "value",
      args: [],
    });
    const getValueCall = await smartAccount.client.call({
      to: addressProxy,
      from: smartAccount.address,
      data: getValueData,
    }, "latest");

    const getValue = decodeFunctionResult({
      abi: LogicContract.abi,
      functionName: "value",
      data: getValueCall.data,
    });
    console.log("✅ Current value in Logic contract:", getValue);

    const { address: addressV2, hash: hashV2 } = await smartAccount.deployContract({
      shardId: 1,
      bytecode: MyLogicV2.bytecode,
      abi: MyLogicV2.abi,
      args: [],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: BigInt(1e15),
    });
    await waitTillCompleted(smartAccount.client, hashV2);
    console.log("✅ Logic V2 Contract deployed at:", addressV2);

    const initDataV2 = encodeFunctionData({
      abi: MyLogicV2.abi,
      functionName: "initializeV2",
      args: [77, "hello world"],
    });

    const encodedUpgrade = encodeFunctionData({
      abi: ProxyAdmin.abi,
      functionName: "upgradeAndCall",
      args: [addressProxy, addressV2, initDataV2],
    });

    const upgradeTx = await smartAccount.sendTransaction({
      to: proxyAdminAddress as `0x${string}`,
      data: encodedUpgrade,
    //   value: convertEthToWei(0.0001),
      feeCredit: convertEthToWei(0.001),
    });
    await waitTillCompleted(smartAccount.client, upgradeTx);
    console.log("✅ Upgrade and initialization transaction sent:", upgradeTx);

    const fetchImplementationCall = encodeFunctionData({
      abi: TransperantProxy.abi,
      functionName: "fetchImplementation",
      args: [],
    });
    const implResult = await smartAccount.client.call({
      to: addressProxy,
      data: fetchImplementationCall,
      from: smartAccount.address,
    }, "latest");
    const currentImpl = decodeFunctionResult({
      abi: TransperantProxy.abi,
      functionName: "fetchImplementation",
      data: implResult.data,
    });
    console.log("Proxy implementation:", currentImpl);
    console.log("Expected implementation:", addressV2);

    const getValueV2Data = encodeFunctionData({
      abi: MyLogicV2.abi,
      functionName: "value",
      args: [],
    });

    const getValueV2Call = await smartAccount.client.call({
      to: addressProxy,
      from: smartAccount.address,
      data: getValueV2Data,
    }, "latest");

    const getValueV2 = decodeFunctionResult({
      abi: MyLogicV2.abi,
      functionName: "value",
      data: getValueV2Call.data,
    });

    console.log("✅ Current value in Logic V2 contract:", getValueV2);
  });
