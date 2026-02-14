// mcp-client.js - Frontend client for MCP integration
import { membrane_htmlElementsToAssetModels, membrane_rawDataToModelAssets, membrane_modelAssetsToHTML } from './membrane.js';
import { Portfolio } from './portfolio.js';
import { chronometer_run } from './chronometer.js';

export class MCPClient {
  constructor(baseUrl = 'http://localhost:3000/api/mcp') {
    this.baseUrl = baseUrl;
  }

  // Connect to an MCP server
  async connectServer(serverName, command, args) {
    try {
      const response = await fetch(`${this.baseUrl}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName, command, args })
      });

      if (!response.ok) {
        throw new Error(`Failed to connect: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error connecting to MCP server:', error);
      throw error;
    }
  }

  // List available servers
  async listServers() {
    try {
      const response = await fetch(`${this.baseUrl}/servers`);
      if (!response.ok) {
        throw new Error(`Failed to list servers: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error listing servers:', error);
      throw error;
    }
  }

  // List available tools from a server
  async listTools(serverName) {
    try {
      const response = await fetch(`${this.baseUrl}/${serverName}/tools`);
      if (!response.ok) {
        throw new Error(`Failed to list tools: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error listing tools:', error);
      throw error;
    }
  }

  // Call a tool
  async callTool(serverName, toolName, args = {}) {
    try {
      const response = await fetch(`${this.baseUrl}/${serverName}/call-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName,
          arguments: args
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to call tool: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error calling tool:', error);
      throw error;
    }
  }

  // List available resources
  async listResources(serverName) {
    try {
      const response = await fetch(`${this.baseUrl}/${serverName}/resources`);
      if (!response.ok) {
        throw new Error(`Failed to list resources: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error listing resources:', error);
      throw error;
    }
  }

  // Read a resource
  async readResource(serverName, uri) {
    try {
      const response = await fetch(`${this.baseUrl}/${serverName}/read-resource`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri })
      });

      if (!response.ok) {
        throw new Error(`Failed to read resource: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error reading resource:', error);
      throw error;
    }
  }

  // Save financial data to file via MCP
  async saveToFile(serverName, filePath, data) {
    try {
      // Using filesystem server's write capability
      return await this.callTool(serverName, 'write_file', {
        path: filePath,
        content: JSON.stringify(data, null, 2)
      });
    } catch (error) {
      console.error('Error saving to file:', error);
      throw error;
    }
  }

  // Load financial data from file via MCP
  async loadFromFile(serverName, filePath) {
    try {
      const result = await this.readResource(serverName, `file://${filePath}`);
      return JSON.parse(result.contents[0].text);
    } catch (error) {
      console.error('Error loading from file:', error);
      throw error;
    }
  }
}

// Global instance
export const mcpClient = new MCPClient();

// Save current portfolio to file
export async function savePortfolioToFile(filePath, assetsContainerElement) {
  try {
    const assetModels = membrane_htmlElementsToAssetModels(assetsContainerElement);
    await mcpClient.saveToFile('filesystem', filePath, {
      version: '1.0',
      savedAt: new Date().toISOString(),
      assets: assetModels
    });
    console.log('Portfolio saved successfully');
    return true;
  } catch (error) {
    console.error('Failed to save portfolio:', error);
    return false;
  }
}

// Load portfolio from file
export async function loadPortfolioFromFile(filePath, assetsContainerElement, calculateFn) {
  try {
    const data = await mcpClient.loadFromFile('filesystem', filePath);
    const assetModels = membrane_rawDataToModelAssets(data.assets);
    assetsContainerElement.innerHTML = membrane_modelAssetsToHTML(assetModels);
    calculateFn('assets');
    console.log('Portfolio loaded successfully');
    return true;
  } catch (error) {
    console.error('Failed to load portfolio:', error);
    return false;
  }
}

// Export financial report via MCP
export async function exportReport(filePath, assetsContainerElement, activeSummaryElement) {
  try {
    const modelAssets = membrane_htmlElementsToAssetModels(assetsContainerElement);
    const portfolio = new Portfolio(modelAssets);
    chronometer_run(activeSummaryElement, portfolio);

    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        startValue: portfolio.startValue().toString(),
        finishValue: portfolio.finishValue().toString(),
        accumulatedValue: portfolio.accumulatedValue().toString(),
        totalMonths: portfolio.totalMonths
      },
      assets: modelAssets.map(asset => ({
        displayName: asset.displayName,
        instrument: asset.instrument,
        startValue: asset.startCurrency.toString(),
        finishValue: asset.finishCurrency.toString(),
        accumulated: asset.accumulatedCurrency.toString()
      }))
    };

    await mcpClient.saveToFile('filesystem', filePath, report);
    console.log('Report exported successfully');
    return true;
  } catch (error) {
    console.error('Failed to export report:', error);
    return false;
  }
}
