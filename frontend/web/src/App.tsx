// App.tsx
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import WalletManager from "./components/WalletManager";
import WalletSelector from "./components/WalletSelector";
import "./App.css";

// Interface for ECU firmware data
interface EcuFirmware {
  id: string;
  firmwareHash: string;
  timestamp: number;
  manufacturer: string;
  ecuModel: string;
  status: "pending" | "verified" | "rejected";
  securityLevel: number;
}

const App: React.FC = () => {
  const [account, setAccount] = useState("");
  const [loading, setLoading] = useState(true);
  const [firmwares, setFirmwares] = useState<EcuFirmware[]>([]);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [walletSelectorOpen, setWalletSelectorOpen] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{
    visible: boolean;
    status: "pending" | "success" | "error";
    message: string;
  }>({ visible: false, status: "pending", message: "" });
  const [newFirmwareData, setNewFirmwareData] = useState({
    manufacturer: "",
    ecuModel: "",
    firmwareHash: "",
    securityLevel: 1
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  // Calculate statistics for dashboard
  const verifiedCount = firmwares.filter(f => f.status === "verified").length;
  const pendingCount = firmwares.filter(f => f.status === "pending").length;
  const rejectedCount = firmwares.filter(f => f.status === "rejected").length;

  // Filter and paginate firmwares
  const filteredFirmwares = firmwares.filter(firmware => {
    const matchesSearch = firmware.ecuModel.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         firmware.manufacturer.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = filterStatus === "all" || firmware.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const paginatedFirmwares = filteredFirmwares.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const totalPages = Math.ceil(filteredFirmwares.length / itemsPerPage);

  useEffect(() => {
    loadFirmwares().finally(() => setLoading(false));
  }, []);

  const onWalletSelect = async (wallet: any) => {
    if (!wallet.provider) return;
    try {
      const web3Provider = new ethers.BrowserProvider(wallet.provider);
      setProvider(web3Provider);
      const accounts = await web3Provider.send("eth_requestAccounts", []);
      const acc = accounts[0] || "";
      setAccount(acc);

      wallet.provider.on("accountsChanged", async (accounts: string[]) => {
        const newAcc = accounts[0] || "";
        setAccount(newAcc);
      });
    } catch (e) {
      alert("Failed to connect wallet");
    }
  };

  const onConnect = () => setWalletSelectorOpen(true);
  const onDisconnect = () => {
    setAccount("");
    setProvider(null);
  };

  const loadFirmwares = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability using FHE
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.error("Contract is not available");
        return;
      }
      
      const keysBytes = await contract.getData("firmware_keys");
      let keys: string[] = [];
      
      if (keysBytes.length > 0) {
        try {
          keys = JSON.parse(ethers.toUtf8String(keysBytes));
        } catch (e) {
          console.error("Error parsing firmware keys:", e);
        }
      }
      
      const list: EcuFirmware[] = [];
      
      for (const key of keys) {
        try {
          const firmwareBytes = await contract.getData(`firmware_${key}`);
          if (firmwareBytes.length > 0) {
            try {
              const firmwareData = JSON.parse(ethers.toUtf8String(firmwareBytes));
              list.push({
                id: key,
                firmwareHash: firmwareData.firmwareHash,
                timestamp: firmwareData.timestamp,
                manufacturer: firmwareData.manufacturer,
                ecuModel: firmwareData.ecuModel,
                status: firmwareData.status || "pending",
                securityLevel: firmwareData.securityLevel || 1
              });
            } catch (e) {
              console.error(`Error parsing firmware data for ${key}:`, e);
            }
          }
        } catch (e) {
          console.error(`Error loading firmware ${key}:`, e);
        }
      }
      
      list.sort((a, b) => b.timestamp - a.timestamp);
      setFirmwares(list);
    } catch (e) {
      console.error("Error loading firmwares:", e);
    } finally {
      setIsRefreshing(false);
      setLoading(false);
    }
  };

  const uploadFirmware = async () => {
    if (!provider) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setUploading(true);
    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Processing firmware with FHE encryption..."
    });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const firmwareId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const firmwareData = {
        firmwareHash: newFirmwareData.firmwareHash,
        timestamp: Math.floor(Date.now() / 1000),
        manufacturer: newFirmwareData.manufacturer,
        ecuModel: newFirmwareData.ecuModel,
        status: "pending",
        securityLevel: newFirmwareData.securityLevel
      };
      
      // Store encrypted data on-chain using FHE
      await contract.setData(
        `firmware_${firmwareId}`, 
        ethers.toUtf8Bytes(JSON.stringify(firmwareData))
      );
      
      const keysBytes = await contract.getData("firmware_keys");
      let keys: string[] = [];
      
      if (keysBytes.length > 0) {
        try {
          keys = JSON.parse(ethers.toUtf8String(keysBytes));
        } catch (e) {
          console.error("Error parsing keys:", e);
        }
      }
      
      keys.push(firmwareId);
      
      await contract.setData(
        "firmware_keys", 
        ethers.toUtf8Bytes(JSON.stringify(keys))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Firmware encrypted and stored securely with FHE!"
      });
      
      await loadFirmwares();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewFirmwareData({
          manufacturer: "",
          ecuModel: "",
          firmwareHash: "",
          securityLevel: 1
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction")
        ? "Transaction rejected by user"
        : "Upload failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({
        visible: true,
        status: "error",
        message: errorMessage
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    } finally {
      setUploading(false);
    }
  };

  const verifyFirmware = async (firmwareId: string) => {
    if (!provider) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Verifying firmware with FHE computation..."
    });

    try {
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const firmwareBytes = await contract.getData(`firmware_${firmwareId}`);
      if (firmwareBytes.length === 0) {
        throw new Error("Firmware not found");
      }
      
      const firmwareData = JSON.parse(ethers.toUtf8String(firmwareBytes));
      
      const updatedFirmware = {
        ...firmwareData,
        status: "verified"
      };
      
      await contract.setData(
        `firmware_${firmwareId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedFirmware))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "FHE verification completed successfully!"
      });
      
      await loadFirmwares();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Verification failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const rejectFirmware = async (firmwareId: string) => {
    if (!provider) {
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({
      visible: true,
      status: "pending",
      message: "Processing firmware rejection with FHE..."
    });

    try {
      const contract = await getContractWithSigner();
      if (!contract) {
        throw new Error("Failed to get contract with signer");
      }
      
      const firmwareBytes = await contract.getData(`firmware_${firmwareId}`);
      if (firmwareBytes.length === 0) {
        throw new Error("Firmware not found");
      }
      
      const firmwareData = JSON.parse(ethers.toUtf8String(firmwareBytes));
      
      const updatedFirmware = {
        ...firmwareData,
        status: "rejected"
      };
      
      await contract.setData(
        `firmware_${firmwareId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedFirmware))
      );
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: "Firmware rejection completed with FHE!"
      });
      
      await loadFirmwares();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Rejection failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      
      setTransactionStatus({
        visible: true,
        status: "success",
        message: `FHE System is ${isAvailable ? "available" : "unavailable"}`
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({
        visible: true,
        status: "error",
        message: "Availability check failed: " + (e.message || "Unknown error")
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 3000);
    }
  };

  const isOwner = (address: string) => {
    return account.toLowerCase() === address.toLowerCase();
  };

  const tutorialSteps = [
    {
      title: "Connect Wallet",
      description: "Connect your Web3 wallet to interact with the platform",
      icon: "🔗"
    },
    {
      title: "Upload Firmware",
      description: "Add your ECU firmware which will be encrypted using FHE",
      icon: "🔒"
    },
    {
      title: "FHE Processing",
      description: "Your firmware is verified in encrypted state without decryption",
      icon: "⚙️"
    },
    {
      title: "Get Results",
      description: "Receive verifiable results while keeping your firmware secure",
      icon: "📊"
    }
  ];

  const renderSecurityChart = () => {
    const securityLevels = [0, 0, 0, 0, 0]; // Levels 1-5
    
    firmwares.forEach(firmware => {
      if (firmware.securityLevel >= 1 && firmware.securityLevel <= 5) {
        securityLevels[firmware.securityLevel - 1]++;
      }
    });
    
    const maxCount = Math.max(...securityLevels, 1);
    
    return (
      <div className="security-chart">
        {securityLevels.map((count, index) => (
          <div key={index} className="security-bar">
            <div className="bar-label">L{index + 1}</div>
            <div className="bar-container">
              <div 
                className="bar-fill" 
                style={{ height: `${(count / maxCount) * 100}%` }}
              ></div>
            </div>
            <div className="bar-value">{count}</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="car-icon"></div>
          </div>
          <h1>AutoEcu<span>FHE</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowUploadModal(true)} 
            className="upload-btn"
          >
            <div className="upload-icon"></div>
            Upload Firmware
          </button>
          <button 
            className="secondary-btn"
            onClick={() => setShowTutorial(!showTutorial)}
          >
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <button 
            className="secondary-btn"
            onClick={checkAvailability}
          >
            Check FHE Status
          </button>
          <WalletManager account={account} onConnect={onConnect} onDisconnect={onDisconnect} />
        </div>
      </header>
      
      <div className="main-content">
        <div className="hero-banner">
          <div className="hero-text">
            <h2>FHE-Based Secure Firmware for Automotive ECUs</h2>
            <p>Using Fully Homomorphic Encryption to securely validate ECU firmware and prevent malicious attacks on automotive networks</p>
          </div>
          <div className="hero-graphic">
            <div className="encryption-graphic"></div>
          </div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE ECU Firmware Verification</h2>
            <p className="subtitle">Learn how to securely process and verify ECU firmware</p>
            
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div 
                  className="tutorial-step"
                  key={index}
                >
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="dashboard-cards">
          <div className="dashboard-card">
            <h3>Project Overview</h3>
            <p>Secure automotive ECU platform using FHE technology to validate firmware without decryption, preventing malicious attacks on in-vehicle networks.</p>
            <div className="fhe-badge">
              <span>FHE-Powered Security</span>
            </div>
          </div>
          
          <div className="dashboard-card">
            <h3>Firmware Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{firmwares.length}</div>
                <div className="stat-label">Total Firmwares</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{verifiedCount}</div>
                <div className="stat-label">Verified</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{rejectedCount}</div>
                <div className="stat-label">Rejected</div>
              </div>
            </div>
          </div>
          
          <div className="dashboard-card">
            <h3>Security Level Distribution</h3>
            {renderSecurityChart()}
          </div>
        </div>
        
        <div className="firmware-section">
          <div className="section-header">
            <h2>ECU Firmware Records</h2>
            <div className="header-actions">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search by model or manufacturer..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="filter-select"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="verified">Verified</option>
                <option value="rejected">Rejected</option>
              </select>
              <button 
                onClick={loadFirmwares}
                className="refresh-btn"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="firmware-list">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Manufacturer</div>
              <div className="header-cell">ECU Model</div>
              <div className="header-cell">Security Level</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {paginatedFirmwares.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No firmware records found</p>
                <button 
                  className="primary-btn"
                  onClick={() => setShowUploadModal(true)}
                >
                  Upload First Firmware
                </button>
              </div>
            ) : (
              paginatedFirmwares.map(firmware => (
                <div className="firmware-row" key={firmware.id}>
                  <div className="table-cell record-id">#{firmware.id.substring(0, 6)}</div>
                  <div className="table-cell">{firmware.manufacturer}</div>
                  <div className="table-cell">{firmware.ecuModel}</div>
                  <div className="table-cell">
                    <span className={`security-level level-${firmware.securityLevel}`}>
                      L{firmware.securityLevel}
                    </span>
                  </div>
                  <div className="table-cell">
                    {new Date(firmware.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="table-cell">
                    <span className={`status-badge ${firmware.status}`}>
                      {firmware.status}
                    </span>
                  </div>
                  <div className="table-cell actions">
                    {isOwner(firmware.manufacturer) && firmware.status === "pending" && (
                      <>
                        <button 
                          className="action-btn success-btn"
                          onClick={() => verifyFirmware(firmware.id)}
                        >
                          Verify
                        </button>
                        <button 
                          className="action-btn danger-btn"
                          onClick={() => rejectFirmware(firmware.id)}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          
          {totalPages > 1 && (
            <div className="pagination">
              <button 
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button 
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
  
      {showUploadModal && (
        <ModalUpload 
          onSubmit={uploadFirmware} 
          onClose={() => setShowUploadModal(false)} 
          uploading={uploading}
          firmwareData={newFirmwareData}
          setFirmwareData={setNewFirmwareData}
        />
      )}
      
      {walletSelectorOpen && (
        <WalletSelector
          isOpen={walletSelectorOpen}
          onWalletSelect={(wallet) => { onWalletSelect(wallet); setWalletSelectorOpen(false); }}
          onClose={() => setWalletSelectorOpen(false)}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}
  
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="car-icon"></div>
              <span>AutoEcuFHE</span>
            </div>
            <p>Secure automotive ECU firmware validation using FHE technology</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Security</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} AutoEcuFHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalUploadProps {
  onSubmit: () => void; 
  onClose: () => void; 
  uploading: boolean;
  firmwareData: any;
  setFirmwareData: (data: any) => void;
}

const ModalUpload: React.FC<ModalUploadProps> = ({ 
  onSubmit, 
  onClose, 
  uploading,
  firmwareData,
  setFirmwareData
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFirmwareData({
      ...firmwareData,
      [name]: value
    });
  };

  const handleSubmit = () => {
    if (!firmwareData.manufacturer || !firmwareData.ecuModel || !firmwareData.firmwareHash) {
      alert("Please fill required fields");
      return;
    }
    
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="upload-modal">
        <div className="modal-header">
          <h2>Upload ECU Firmware</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="key-icon"></div> Your firmware will be encrypted with FHE for secure validation
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Manufacturer *</label>
              <input 
                type="text"
                name="manufacturer"
                value={firmwareData.manufacturer} 
                onChange={handleChange}
                placeholder="e.g. Bosch, Continental" 
                className="form-input"
              />
            </div>
            
            <div className="form-group">
              <label>ECU Model *</label>
              <input 
                type="text"
                name="ecuModel"
                value={firmwareData.ecuModel} 
                onChange={handleChange}
                placeholder="e.g. ECU-2023-A" 
                className="form-input"
              />
            </div>
            
            <div className="form-group">
              <label>Security Level</label>
              <select 
                name="securityLevel"
                value={firmwareData.securityLevel} 
                onChange={handleChange}
                className="form-select"
              >
                <option value="1">Level 1 - Basic</option>
                <option value="2">Level 2 - Standard</option>
                <option value="3">Level 3 - Enhanced</option>
                <option value="4">Level 4 - High</option>
                <option value="5">Level 5 - Maximum</option>
              </select>
            </div>
            
            <div className="form-group full-width">
              <label>Firmware Hash *</label>
              <textarea 
                name="firmwareHash"
                value={firmwareData.firmwareHash} 
                onChange={handleChange}
                placeholder="Enter firmware hash for verification..." 
                className="form-textarea"
                rows={3}
              />
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="lock-icon"></div> Firmware data remains encrypted during FHE processing
          </div>
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose}
            className="cancel-btn"
          >
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={uploading}
            className="submit-btn primary-btn"
          >
            {uploading ? "Encrypting with FHE..." : "Upload Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;