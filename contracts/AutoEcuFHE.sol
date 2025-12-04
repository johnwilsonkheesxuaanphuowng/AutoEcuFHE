// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AutoEcuFHE is SepoliaConfig {
    struct EncryptedCanMessage {
        uint256 id;
        euint32 encryptedCommand;
        euint32 encryptedSourceEcu;
        euint32 encryptedTargetEcu;
        uint256 timestamp;
    }
    
    struct DecryptedCanMessage {
        string command;
        string sourceEcu;
        string targetEcu;
        bool isVerified;
    }

    uint256 public messageCount;
    mapping(uint256 => EncryptedCanMessage) public encryptedMessages;
    mapping(uint256 => DecryptedCanMessage) public decryptedMessages;
    
    mapping(string => euint32) private encryptedEcuStats;
    string[] private ecuList;
    
    mapping(uint256 => uint256) private requestToMessageId;
    
    event MessageReceived(uint256 indexed id, uint256 timestamp);
    event VerificationRequested(uint256 indexed id);
    event MessageVerified(uint256 indexed id);
    
    modifier onlyAuthorized(uint256 messageId) {
        _;
    }
    
    function submitEncryptedCanMessage(
        euint32 encryptedCommand,
        euint32 encryptedSourceEcu,
        euint32 encryptedTargetEcu
    ) public {
        messageCount += 1;
        uint256 newId = messageCount;
        
        encryptedMessages[newId] = EncryptedCanMessage({
            id: newId,
            encryptedCommand: encryptedCommand,
            encryptedSourceEcu: encryptedSourceEcu,
            encryptedTargetEcu: encryptedTargetEcu,
            timestamp: block.timestamp
        });
        
        decryptedMessages[newId] = DecryptedCanMessage({
            command: "",
            sourceEcu: "",
            targetEcu: "",
            isVerified: false
        });
        
        emit MessageReceived(newId, block.timestamp);
    }
    
    function requestCommandVerification(uint256 messageId) public onlyAuthorized(messageId) {
        EncryptedCanMessage storage msg = encryptedMessages[messageId];
        require(!decryptedMessages[messageId].isVerified, "Already verified");
        
        bytes32[] memory ciphertexts = new bytes32[](3);
        ciphertexts[0] = FHE.toBytes32(msg.encryptedCommand);
        ciphertexts[1] = FHE.toBytes32(msg.encryptedSourceEcu);
        ciphertexts[2] = FHE.toBytes32(msg.encryptedTargetEcu);
        
        uint256 reqId = FHE.requestDecryption(ciphertexts, this.verifyCommand.selector);
        requestToMessageId[reqId] = messageId;
        
        emit VerificationRequested(messageId);
    }
    
    function verifyCommand(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        uint256 messageId = requestToMessageId[requestId];
        require(messageId != 0, "Invalid request");
        
        EncryptedCanMessage storage eMsg = encryptedMessages[messageId];
        DecryptedCanMessage storage dMsg = decryptedMessages[messageId];
        require(!dMsg.isVerified, "Already verified");
        
        FHE.checkSignatures(requestId, cleartexts, proof);
        
        (string memory command, string memory sourceEcu, string memory targetEcu) = 
            abi.decode(cleartexts, (string, string, string));
        
        dMsg.command = command;
        dMsg.sourceEcu = sourceEcu;
        dMsg.targetEcu = targetEcu;
        dMsg.isVerified = true;
        
        if (FHE.isInitialized(encryptedEcuStats[dMsg.sourceEcu]) == false) {
            encryptedEcuStats[dMsg.sourceEcu] = FHE.asEuint32(0);
            ecuList.push(dMsg.sourceEcu);
        }
        encryptedEcuStats[dMsg.sourceEcu] = FHE.add(
            encryptedEcuStats[dMsg.sourceEcu], 
            FHE.asEuint32(1)
        );
        
        emit MessageVerified(messageId);
    }
    
    function getDecryptedMessage(uint256 messageId) public view returns (
        string memory command,
        string memory sourceEcu,
        string memory targetEcu,
        bool isVerified
    ) {
        DecryptedCanMessage storage m = decryptedMessages[messageId];
        return (m.command, m.sourceEcu, m.targetEcu, m.isVerified);
    }
    
    function getEncryptedEcuStats(string memory ecuId) public view returns (euint32) {
        return encryptedEcuStats[ecuId];
    }
    
    function requestEcuStatsDecryption(string memory ecuId) public {
        euint32 stats = encryptedEcuStats[ecuId];
        require(FHE.isInitialized(stats), "ECU not found");
        
        bytes32[] memory ciphertexts = new bytes32[](1);
        ciphertexts[0] = FHE.toBytes32(stats);
        
        uint256 reqId = FHE.requestDecryption(ciphertexts, this.decryptEcuStats.selector);
        requestToMessageId[reqId] = bytes32ToUint(keccak256(abi.encodePacked(ecuId)));
    }
    
    function decryptEcuStats(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        uint256 ecuHash = requestToMessageId[requestId];
        string memory ecuId = getEcuFromHash(ecuHash);
        
        FHE.checkSignatures(requestId, cleartexts, proof);
        
        uint32 stats = abi.decode(cleartexts, (uint32));
    }
    
    function bytes32ToUint(bytes32 b) private pure returns (uint256) {
        return uint256(b);
    }
    
    function getEcuFromHash(uint256 hash) private view returns (string memory) {
        for (uint i = 0; i < ecuList.length; i++) {
            if (bytes32ToUint(keccak256(abi.encodePacked(ecuList[i]))) == hash) {
                return ecuList[i];
            }
        }
        revert("ECU not found");
    }
    
    function validateCommand(
        string memory command,
        string memory sourceEcu,
        string memory targetEcu
    ) public view returns (bool isValid) {
        // Simplified command validation
        // In real implementation, this would check against ECU whitelist and command patterns
        return true;
    }
    
    function detectAnomalousCommands(
        string memory ecuId,
        string[] memory knownSafeCommands
    ) public view returns (bool isAnomalous) {
        for (uint256 i = 1; i <= messageCount; i++) {
            if (decryptedMessages[i].isVerified && 
                keccak256(abi.encodePacked(decryptedMessages[i].sourceEcu)) == keccak256(abi.encodePacked(ecuId))) {
                bool isSafe = false;
                for (uint256 j = 0; j < knownSafeCommands.length; j++) {
                    if (keccak256(abi.encodePacked(decryptedMessages[i].command)) == keccak256(abi.encodePacked(knownSafeCommands[j]))) {
                        isSafe = true;
                        break;
                    }
                }
                if (!isSafe) {
                    return true;
                }
            }
        }
        return false;
    }
    
    function calculateEcuTrustScore(
        string memory ecuId
    ) public view returns (uint256 trustScore) {
        uint256 validCount = 0;
        uint256 totalCount = 0;
        
        for (uint256 i = 1; i <= messageCount; i++) {
            if (decryptedMessages[i].isVerified && 
                keccak256(abi.encodePacked(decryptedMessages[i].sourceEcu)) == keccak256(abi.encodePacked(ecuId))) {
                totalCount++;
                if (validateCommand(decryptedMessages[i].command, decryptedMessages[i].sourceEcu, decryptedMessages[i].targetEcu)) {
                    validCount++;
                }
            }
        }
        
        return totalCount > 0 ? (validCount * 100) / totalCount : 100;
    }
    
    function identifySuspiciousEcuPairs() public view returns (string[] memory suspiciousPairs) {
        uint256 count = 0;
        
        for (uint256 i = 1; i <= messageCount; i++) {
            if (decryptedMessages[i].isVerified && 
                !validateCommand(decryptedMessages[i].command, decryptedMessages[i].sourceEcu, decryptedMessages[i].targetEcu)) {
                count++;
            }
        }
        
        suspiciousPairs = new string[](count * 2);
        uint256 index = 0;
        for (uint256 i = 1; i <= messageCount; i++) {
            if (decryptedMessages[i].isVerified && 
                !validateCommand(decryptedMessages[i].command, decryptedMessages[i].sourceEcu, decryptedMessages[i].targetEcu)) {
                suspiciousPairs[index] = decryptedMessages[i].sourceEcu;
                suspiciousPairs[index + 1] = decryptedMessages[i].targetEcu;
                index += 2;
            }
        }
        return suspiciousPairs;
    }
    
    function enforceSecurityPolicy(
        string memory ecuId,
        string memory policy
    ) public view returns (bool isCompliant) {
        // Simplified policy enforcement
        // In real implementation, this would check against detailed security policies
        return true;
    }
}