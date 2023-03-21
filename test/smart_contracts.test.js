import { expect } from "chai";

import { getCurveFromName } from "../src/curves.js";
import path from "path";
import hardhat from "hardhat";
const { ethers, run } = hardhat;

import * as zkey from "../src/zkey.js";

import fs from "fs";

describe("Smart contracts test suite", function () {
    this.timeout(1000000000);

    let verifierContract;
    let curve;

    before(async () => {
        curve = await getCurveFromName("bn128");
    });

    after(async () => {
        await curve.terminate();
    });

    it("fflonk smart contract", async () => {
        const publicInputsFilename = path.join("test", "fflonk", "public.json");
        const proofFilename = path.join("test", "fflonk", "proof.json");
        const zkeyFilename = path.join("test", "fflonk", "circuit.zkey");
        const solidityVerifierFilename = path.join("test", "smart_contracts", "contracts", "fflonk.sol");

        // Load fflonk template
        const templates = {};
        templates.fflonk = await fs.promises.readFile(path.join("templates", "verifier_fflonk.sol.ejs"), "utf8");

        // Generate fflonk verifier solidity file from fflonk template + zkey
        const verifierCode = await zkey.exportSolidityVerifier(zkeyFilename, templates);
        fs.writeFileSync(solidityVerifierFilename, verifierCode, "utf-8");

        // Compile the fflonk verifier smart contract
        await run("compile");

        // Deploy mock fflonk verifier
        const VerifierFactory = await ethers.getContractFactory("FflonkVerifier");
        verifierContract = await VerifierFactory.deploy();

        // Read last test generated fflonk proof & public inputs
        const proofJson = JSON.parse(await fs.promises.readFile(proofFilename, "utf8"));
        const publicInputs = JSON.parse(await fs.promises.readFile(publicInputsFilename, "utf8"));

        // Verifiy the proof in the smart contract
        const proof = generateSolidityInputs(proofJson);
        expect(await verifierContract.verifyProof(proof, publicInputs)).to.be.equal(true);
    });
});

function generateSolidityInputs(proofJson) {
    const { evaluations, polynomials } = proofJson;

    const arrayStrings = Array(24).fill("bytes32");

    const proof = ethers.utils.defaultAbiCoder.encode(
        arrayStrings,
        [
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.C1[0]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.C1[1]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.C2[0]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.C2[1]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.W1[0]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.W1[1]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.W2[0]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(polynomials.W2[1]).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.ql).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.qr).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.qm).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.qo).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.qc).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.s1).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.s2).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.s3).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.a).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.b).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.c).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.z).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.zw).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.t1w).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.t2w).toHexString(), 32),
            ethers.utils.hexZeroPad(ethers.BigNumber.from(evaluations.inv).toHexString(), 32),
        ],
    );

    return proof;
}