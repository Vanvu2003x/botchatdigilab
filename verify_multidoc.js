const axios = require("axios");
require('dotenv').config();

const PORT = process.env.PORT || 41725;

async function runTest() {
  try {
    // 1. Fetch current documents
    console.log("Fetching documents...");
    const getRes = await axios.get(`http://localhost:${PORT}/api/knowledge`);
    const docs = getRes.data.documents;
    console.log("Current documents count:", docs.length);
    console.log("Documents list:", docs.map(d => d.title));
    
    // Check if migration worked
    const migratedDoc = docs.find(d => d.id === "doc_default");
    if (migratedDoc) {
      console.log("Migration check passed! Default document exists.");
    } else {
      console.warn("Migration check warning: Default document not found (might have been cleared or not migrated).");
    }
    
    // 2. Create a new document
    console.log("Creating new document...");
    const createRes = await axios.post(`http://localhost:${PORT}/api/knowledge`, {
      title: "Chinh sach bao hanh",
      content: "Bao hanh 12 thang doi voi tat ca san pham Robotics."
    });
    
    const newDoc = createRes.data.document;
    console.log("Created Document:", newDoc);
    
    // Verify it exists in list
    const getRes2 = await axios.get(`http://localhost:${PORT}/api/knowledge`);
    const docs2 = getRes2.data.documents;
    if (docs2.some(d => d.id === newDoc.id)) {
      console.log("Verification passed: New document exists in list.");
    } else {
      throw new Error("New document not found in list!");
    }
    
    // 3. Delete the new document
    console.log("Deleting new document...");
    const deleteRes = await axios.delete(`http://localhost:${PORT}/api/knowledge/${newDoc.id}`);
    console.log("Delete response:", deleteRes.data);
    
    // Verify it is removed
    const getRes3 = await axios.get(`http://localhost:${PORT}/api/knowledge`);
    const docs3 = getRes3.data.documents;
    if (!docs3.some(d => d.id === newDoc.id)) {
      console.log("Verification passed: New document successfully deleted.");
    } else {
      throw new Error("New document still exists in list!");
    }
    
    console.log("ALL VERIFICATIONS COMPLETED SUCCESSFULLY!");
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err.message);
    if (err.response) {
      console.error("Response details:", err.response.data);
    }
    process.exit(1);
  }
}

runTest();
