
import { splitMultiLineTimestampComment } from "../src/content/network.ts"; 


const text = "Did anyone notice:\r\n\r\n0:02 Rock Paper Scissors \r\n0:05 Hide and Seek\r\n0:14 Red Light Green Light\r\n1:11 Tag\n2:37 Thumb War\n3:02 Rock Paper Scissors again";

const result = splitMultiLineTimestampComment(text);

result?.forEach((line) => {
    console.log(line);
});