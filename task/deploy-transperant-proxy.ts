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
  generateSmartAccount,
  waitTillCompleted,
} from "@nilfoundation/niljs";
import { ethers } from "ethers";
import "dotenv/config";
import { decodeFunctionResult, encodeFunctionData, encodeDeployData } from "viem";

let smartAccount: SmartAccountV1 | null = null; // Variable to store the initialized SmartAccountV1

async function getSmartAccount(): Promise<SmartAccountV1> {
  const rpcEndpoint = process.env.NIL_RPC_ENDPOINT as string;
  const client = new PublicClient({
    transport: new HttpTransport({ endpoint: rpcEndpoint }),
  });
  const faucetClient = new FaucetClient({
    transport: new HttpTransport({ endpoint: rpcEndpoint }),
  });

  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
  const smartAccountAddress = process.env
    .SMART_ACCOUNT_ADDRESS as `0x${string}`;

  if (privateKey && smartAccountAddress) {
    console.log("🔹 Using existing Smart Account...");
    const signer = new LocalECDSAKeySigner({ privateKey });
    smartAccount = new SmartAccountV1({
      signer,
      client,
      address: smartAccountAddress,
      pubkey: signer.getPublicKey(),
    });

    console.log("🟢 Loaded Smart Account:", smartAccount.address);
  } else {
    console.log("🚀 Generating New Smart Account...");

    const privateKey = generateRandomPrivateKey();

    const signer = new LocalECDSAKeySigner({ privateKey });
    smartAccount = new SmartAccountV1({
      signer,
      client,
      salt: BigInt(Math.floor(Math.random() * 10000)),
      shardId: 1,
      pubkey: signer.getPublicKey(),
    });

    const accountDetails = {
      PRIVATE_KEY: privateKey,
      SMART_ACCOUNT_ADDRESS: smartAccount.address,
    };

    fs.writeFileSync("smartAccount.json", JSON.stringify(accountDetails));
  }

  // ✅ Fund the Smart Account
  const topUpFaucet = await faucetClient.topUp({
    smartAccountAddress: smartAccount.address,
    amount: ethers.parseEther("0.01"), // Ensure enough ETH for operations
    faucetAddress: process.env.NIL as `0x${string}`,
  });

  await waitTillCompleted(client, topUpFaucet);

  if ((await smartAccount.checkDeploymentStatus()) === false) {
    await smartAccount.selfDeploy(true);
    console.log("🆕 New Smart Account Generated:", smartAccount.address);
  }

  console.log("✅ Smart Account Funded (0.01 ETH)");
  return smartAccount;
}

task(
  "deploy-transperant-proxy",
  "Deploys a transparent proxy contract",
).setAction(async () => {
  const LogicContract = require("../artifacts/contracts/MyLogic.sol/MyLogic.json");
  const TransperantProxy = require("../artifacts/contracts/TransparentUpgradeableProxy.sol/MyTransparentUpgradeableProxy.json");
  const ProxyAdmin = require("../artifacts/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json");
  const MyLogicV2 = require("../artifacts/contracts/MyLogicV2.sol/MyLogicV2.json");

  const deployerAccount = await getSmartAccount();

  if (!smartAccount) {
    throw new Error("SmartAccount is not initialized.");
  }

  const { address: addressLogic, hash: hashLogic } =
    await deployerAccount.deployContract({
      shardId: 1,
      bytecode: LogicContract.bytecode,
      abi: LogicContract.abi,
      args: [],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: convertEthToWei(0.001),
    });

  await waitTillCompleted(deployerAccount.client, hashLogic);
  console.log("✅ Logic Contract deployed at:", addressLogic);
  console.log("✅ Transaction Hash:", hashLogic);

  const { address: addressProxyAdmin, hash: hashProxyAdmin } =
    await deployerAccount.deployContract({
      shardId: 1,
      bytecode: ProxyAdmin.bytecode,
      abi: ProxyAdmin.abi,
      args: [deployerAccount.address],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: convertEthToWei(0.001),
    });
  await waitTillCompleted(deployerAccount.client, hashProxyAdmin);
  console.log("✅ Proxy Admin Contract deployed at:", addressProxyAdmin);
  console.log("✅ Transaction Hash:", hashProxyAdmin);

  const initData = encodeFunctionData({
    abi: LogicContract.abi,
    functionName: "initialize",
    args: [42],
  });

  console.log("Deploying Proxy with args:");
  console.log("Logic:", addressLogic);
  console.log("Admin:", addressProxyAdmin); // this must match
  console.log("Init data:", initData);


  const { address: addressProxy, hash: hashProxy } =
    await deployerAccount.deployContract({
      shardId: 1,
      bytecode: TransperantProxy.bytecode,
      abi: TransperantProxy.abi,
      args: [addressLogic, addressProxyAdmin, initData],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: convertEthToWei(0.001),
    });

  await waitTillCompleted(deployerAccount.client, hashProxy);
  console.log("✅ Transparent Proxy Contract deployed at:", addressProxy);
  console.log("✅ Transaction Hash:", hashProxy);
  console.log("Waiting 5 seconds...");
  await new Promise((res) => setTimeout(res, 5000));
  const adminData = encodeFunctionData({
    abi: TransperantProxy.abi,
    functionName: "fetchAdmin",
    args: [],
  });

  const implementationResult = await smartAccount.client.call(
    {
      to: addressProxy,
      data: adminData,
      from: smartAccount.address,
    },
    "latest",
  );

  const admin = decodeFunctionResult({
    abi: TransperantProxy.abi,
    functionName: "fetchAdmin",
    data: implementationResult.data,
  }) as string;
  console.log("Admin:", admin);
  console.log("Done!");

  const getValueData = encodeFunctionData({
    abi: LogicContract.abi,
    functionName: "value",
    args: [],
  });
  const getValueCall = await smartAccount.client.call(
    {
      to: addressProxy,
      from: smartAccount.address,
      data: getValueData,
    },
    "latest",
  );

  console.log(
    "Encoded getValue call data:",
    getValueCall.data,
    getValueCall.decodedData,
  );

  const getValue = decodeFunctionResult({
    abi: LogicContract.abi,
    functionName: "value",
    data: getValueCall.data,
  });

  console.log("✅ Current value in Logic contract:", getValue);

  const { address: addressV2, hash: hashV2 } =
    await smartAccount.deployContract({
      shardId: 1,
      bytecode: MyLogicV2.bytecode,
      abi: MyLogicV2.abi,
      args: [],
      salt: BigInt(Math.floor(Math.random() * 10000)),
      feeCredit: BigInt(1e15),
    });

  await waitTillCompleted(smartAccount.client, hashV2);

  console.log("✅ Logic V2 Contract deployed at:", addressV2);
  console.log("✅ Transaction Hash:", hashV2);

  // Step 2: Encode initializeV2 call
  const initDataV2 = encodeFunctionData({
    abi: MyLogicV2.abi,
    functionName: "initializeV2",
    args: [77, "hello world"],
  });

  // Step 3: Call ProxyAdmin.upgradeAndCall(proxy, newImpl, data)
  const encodedUpgrade = encodeFunctionData({
    abi: ProxyAdmin.abi,
    functionName: "upgradeAndCall",
    args: [addressProxy, addressV2, initDataV2],
  });

  const upgradeTx = await smartAccount.sendTransaction({
    to: addressProxyAdmin,
    data: encodedUpgrade,
    value: convertEthToWei(0.0001),
    feeCredit: convertEthToWei(0.001),
  });

  await waitTillCompleted(smartAccount.client, upgradeTx);
  console.log("✅ Upgrade and initialization transaction sent:", upgradeTx);

  console.log("Waiting 5 seconds...");
  await new Promise((res) => setTimeout(res, 5000));
  console.log("Done!");

  try {
    // 1. Check ProxyAdmin owner
    const ownerData = encodeFunctionData({
      abi: ProxyAdmin.abi,
      functionName: "owner",
      args: [],
    });

    const ownerResult = await smartAccount.client.call(
      {
        to: addressProxyAdmin,
        data: ownerData,
        from: smartAccount.address,
      },
      "latest",
    );

    const owner = decodeFunctionResult({
      abi: ProxyAdmin.abi,
      functionName: "owner",
      data: ownerResult.data,
    }) as string;

    console.log("ProxyAdmin owner:", owner);
    console.log("Smart Account address:", smartAccount.address);
    console.log(
      "Is admin the smart account?",
      owner.toLowerCase() === smartAccount.address.toLowerCase(),
    );

    // 2. Check Proxy implementation
    const implementationData = encodeFunctionData({
      abi: TransperantProxy.abi,
      functionName: "fetchImplementation",
      args: [],
    });

    const implementationResult = await smartAccount.client.call(
      {
        to: addressProxy,
        data: implementationData,
        from: smartAccount.address,
      },
      "latest",
    );

    const implementation = decodeFunctionResult({
      abi: TransperantProxy.abi,
      functionName: "fetchImplementation",
      data: implementationResult.data,
    }) as string;
    console.log("Proxy implementation:", implementation);

    console.log("Expected implementation:", addressLogic);
    console.log("New implementation:", addressV2);

    const fetchAdmin = encodeFunctionData({
      abi: TransperantProxy.abi,
      functionName: "fetchAdmin",
      args: [],
    });

    const fetchAdminResult = await smartAccount.client.call(
      {
        to: addressProxy,
        data: fetchAdmin,
        from: smartAccount.address,
      },
      "latest",
    );
    const fetchAdminAddress = decodeFunctionResult({
      abi: TransperantProxy.abi,
      functionName: "fetchAdmin",
      data: fetchAdminResult.data,
    }) as string;

    console.log("Proxy admin:", fetchAdminAddress);
    console.log("Expected admin:", addressProxyAdmin);
  } catch (error) {
    console.error("Debug failed:", error);
  }

  // const initialiseV2Data = await smartAccount.sendTransaction({
  //     to : addressProxy,
  //     data : initDataV2,
  //     feeCredit: convertEthToWei(0.001),
  // })

  // console.log("Waiting 5 seconds...");
  // await new Promise((res) => setTimeout(res, 5000));
  // console.log("Done!");

  // await waitTillCompleted(smartAccount.client, initialiseV2Data);
  // console.log("✅ Logic V2 Contract initialized at:", addressProxy);

  const getValueDataV2 = encodeFunctionData({
    abi: MyLogicV2.abi,
    functionName: "value",
    args: [],
  });

  const valueResult = await smartAccount.client.call(
    {
      to: addressProxy,
      data: getValueDataV2,
      from: smartAccount.address,
    },
    "latest",
  );

  console.log(
    "Encoded getValue call data:",
    valueResult.data,
    valueResult.decodedData,
  );
  const value = decodeFunctionResult({
    abi: MyLogicV2.abi,
    functionName: "value",
    data: valueResult.data,
  });
  console.log("✅ Current value in Logic V2 contract:", value);

  //     const encodedSetMsg = encodeFunctionData({
  //         abi: MyLogicV2.abi,
  //         functionName: "setMessage",
  //         args: ["gm gm"],
  //       });

  //   try {
  //         const tx = await smartAccount.sendTransaction({
  //           to: addressProxy,
  //           data: encodedSetMsg,
  //           feeCredit: BigInt(1e15),
  //         });
  //         console.log("Encoded setMessage call data:", tx);
  //         await waitTillCompleted(smartAccount.client, tx);
  //         console.log("✅ Message updated to: gm gm");
  //   } catch (error) {
  //     console.log(error)
  //   }
  // console.log("Waiting 5 seconds...");
  // await new Promise((res) => setTimeout(res, 5000));
  // console.log("Done!");

  //     const getMessageData = encodeFunctionData({
  //         abi: MyLogicV2.abi,
  //         functionName: "getMessage",
  //         args: [],
  //     });

  //     const messageResult = await smartAccount.client.call({
  //         to: addressProxy,
  //         data: getMessageData,
  //         from: smartAccount.address,
  //     }, "latest");

  //     console.log("Encoded getMessage call data:", messageResult.data, messageResult.decodedData);
  //     const message = decodeFunctionResult({
  //         abi: MyLogicV2.abi,
  //         functionName: "getMessage",
  //         data: messageResult.data,
  //     });
  //     console.log("✅ Current message in Logic V2 contract:", message);
});
